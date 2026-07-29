// Full-duplex terminal audio bridge with Apple voice processing (AEC).
//
//   stdin  <- raw PCM16 mono 24kHz to play through the speakers
//   stdout -> raw PCM16 mono 24kHz captured from the microphone
//   SIGUSR1: drop any queued speaker audio (barge-in flush)
//
// Two independent engines: attaching a speaker source to a voice-processed
// engine silently kills its input tap, so playback runs on its own plain
// engine. Voice processing (echo cancellation) is attempted on the input
// engine and abandoned if the mic delivers nothing: on some devices
// (Bluetooth headsets mid-negotiation) the VP tap never fires. Without VP
// there is no echo cancellation, which is acceptable exactly when it happens:
// headphones have no echo path.
//
// Compiled on demand by spike.ts: swiftc -O duplex-audio.swift -o duplex-audio

import AVFoundation

let stderr = FileHandle.standardError
func log(_ message: String) { stderr.write(Data("[audio] \(message)\n".utf8)) }

final class SpeakerQueue {
  private static let capacity = 24_000 * 2 * 30
  private var data = [UInt8](repeating: 0, count: capacity)
  private var readIndex = 0
  private var writeIndex = 0
  private var count = 0
  private let lock = NSLock()
  func push(_ chunk: Data) {
    if chunk.isEmpty { return }
    lock.lock()
    defer { lock.unlock() }
    chunk.withUnsafeBytes { source in
      let skipped = max(0, source.count - Self.capacity)
      let start = skipped + skipped % 2
      let bytes = source.count - start
      let overflow = max(0, count + bytes - Self.capacity)
      let dropped = min(count, overflow + overflow % 2)
      readIndex = (readIndex + dropped) % Self.capacity
      count -= dropped
      let first = min(bytes, Self.capacity - writeIndex)
      data.withUnsafeMutableBytes { destination in
        destination.baseAddress!.advanced(by: writeIndex).copyMemory(
          from: source.baseAddress!.advanced(by: start), byteCount: first)
        destination.baseAddress!.copyMemory(
          from: source.baseAddress!.advanced(by: start + first), byteCount: bytes - first)
      }
      writeIndex = (writeIndex + bytes) % Self.capacity
      count += bytes
    }
  }
  func render(frames: Int, into output: UnsafeMutablePointer<Float>) {
    lock.lock()
    defer { lock.unlock() }
    let samples = min(frames, count / 2)
    for index in 0..<samples {
      let low = UInt16(data[readIndex])
      let high = UInt16(data[(readIndex + 1) % Self.capacity])
      output[index] = Float(Int16(bitPattern: low | high << 8)) / 32768.0
      readIndex = (readIndex + 2) % Self.capacity
    }
    count -= samples * 2
    for index in samples..<frames { output[index] = 0 }
  }
  func flush() {
    lock.lock()
    readIndex = writeIndex
    count = 0
    lock.unlock()
  }
}

#if QUEUE_BENCHMARK
let correctnessQueue = SpeakerQueue()
correctnessQueue.push(Data([0x00, 0x80, 0xff, 0x7f]))
var correctnessOutput = [Float](repeating: 1, count: 3)
correctnessOutput.withUnsafeMutableBufferPointer {
  correctnessQueue.render(frames: 3, into: $0.baseAddress!)
}
precondition(correctnessOutput[0] == -1)
precondition(abs(correctnessOutput[1] - Float(Int16.max) / 32768) < 0.000_001)
precondition(correctnessOutput[2] == 0)
correctnessQueue.push(Data([1, 0]))
correctnessQueue.flush()
correctnessOutput.withUnsafeMutableBufferPointer {
  correctnessQueue.render(frames: 3, into: $0.baseAddress!)
}
precondition(correctnessOutput.allSatisfy { $0 == 0 })

let benchmarkQueue = SpeakerQueue()
let benchmarkFrames = 512
let benchmarkChunk = Data(repeating: 1, count: benchmarkFrames * 2)
var benchmarkOutput = [Float](repeating: 0, count: benchmarkFrames)
for _ in 0..<48 { benchmarkQueue.push(benchmarkChunk) }
for _ in 0..<2_000 {
  benchmarkOutput.withUnsafeMutableBufferPointer {
    benchmarkQueue.render(frames: benchmarkFrames, into: $0.baseAddress!)
  }
  benchmarkQueue.push(benchmarkChunk)
}
var benchmarkDurations = [UInt64]()
benchmarkDurations.reserveCapacity(30_000)
var benchmarkChecksum: Float = 0
for _ in 0..<30_000 {
  let started = DispatchTime.now().uptimeNanoseconds
  benchmarkOutput.withUnsafeMutableBufferPointer {
    benchmarkQueue.render(frames: benchmarkFrames, into: $0.baseAddress!)
  }
  benchmarkQueue.push(benchmarkChunk)
  benchmarkDurations.append(DispatchTime.now().uptimeNanoseconds - started)
  benchmarkChecksum += benchmarkOutput[0]
}
benchmarkDurations.sort()
print("METRIC speaker_queue_median_ns=\(benchmarkDurations[benchmarkDurations.count / 2])")
print("METRIC speaker_queue_p99_ns=\(benchmarkDurations[benchmarkDurations.count * 99 / 100])")
print("METRIC speaker_queue_worst_ns=\(benchmarkDurations.last!)")
print("CHECKSUM \(benchmarkChecksum)")
exit(0)
#endif

let queue = SpeakerQueue()
let playFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 24000, channels: 1, interleaved: false)!
let captureFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 24000, channels: 1, interleaved: true)!
var rebuildScheduled = false
var ignoreRouteChangesUntil = Date.distantPast

func scheduleRebuild(_ message: String, after delay: TimeInterval = 0.5) {
  if rebuildScheduled { return }
  rebuildScheduled = true
  DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
    rebuildScheduled = false
    // Starting an engine emits configuration changes of its own. AirPods can
    // otherwise turn one real route change into a perpetual rebuild loop.
    ignoreRouteChangesUntil = Date().addingTimeInterval(1.5)
    log(message)
    startInput(voiceProcessing: useAEC)
    startOutput()
  }
}

// Speaker: its own engine, pulling PCM16 from the stdin-fed queue.
var outputEngine: AVAudioEngine?

func startOutput() {
  outputEngine?.stop()
  let engine = AVAudioEngine()
  outputEngine = engine
  let source = AVAudioSourceNode(format: playFormat) { _, _, frameCount, audioBufferList -> OSStatus in
    let out = UnsafeMutableAudioBufferListPointer(audioBufferList)[0].mData!.assumingMemoryBound(to: Float.self)
    queue.render(frames: Int(frameCount), into: out)
    return noErr
  }
  engine.attach(source)
  engine.connect(source, to: engine.mainMixerNode, format: playFormat)
  do {
    try engine.start()
    let format = engine.outputNode.outputFormat(forBus: 0)
    log("output active (\(Int(format.sampleRate))Hz, \(format.channelCount)ch)")
  } catch {
    log("output engine failed: \(error)")
    scheduleRebuild("audio engines unavailable — retrying")
  }
}

// Microphone: take channel 0 of whatever the hardware provides, resample to
// 24kHz PCM16 for stdout. Channel extraction is manual because hardware
// channel counts vary wildly (1, 2, 3, 22...) and AVAudioConverter cannot
// downmix all of them.
var tapCount = 0
var inputEngine: AVAudioEngine?
var useAEC = CommandLine.arguments.contains("--aec")

func startInput(voiceProcessing: Bool) {
  inputEngine?.stop()
  let engine = AVAudioEngine()
  inputEngine = engine
  if voiceProcessing {
    do {
      try engine.inputNode.setVoiceProcessingEnabled(true)
    } catch {
      log("voice processing unavailable (\(error)) — no echo cancellation")
      useAEC = false
      return startInput(voiceProcessing: false)
    }
    if #available(macOS 14.0, *) {
      engine.inputNode.voiceProcessingOtherAudioDuckingConfiguration = .init(
        enableAdvancedDucking: false,
        duckingLevel: .min
      )
    }
  }

  let micFormat = engine.inputNode.outputFormat(forBus: 0)
  guard micFormat.sampleRate > 0, micFormat.channelCount > 0, let monoFormat = AVAudioFormat(
    commonFormat: .pcmFormatFloat32, sampleRate: micFormat.sampleRate, channels: 1, interleaved: false)
  else {
    log("microphone route is not ready — retrying")
    scheduleRebuild("audio engines unavailable — retrying")
    return
  }
  guard let converter = AVAudioConverter(from: monoFormat, to: captureFormat) else {
    log("cannot convert \(micFormat.sampleRate)Hz to 24kHz — retrying")
    scheduleRebuild("audio engines unavailable — retrying")
    return
  }

  engine.inputNode.installTap(onBus: 0, bufferSize: 2400, format: micFormat) { buffer, _ in
    tapCount += 1
    if tapCount == 1 { log("mic active (echo cancellation \(voiceProcessing ? "on" : "off"))") }
    guard let channel = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return }
    guard let mono = AVAudioPCMBuffer(pcmFormat: monoFormat, frameCapacity: buffer.frameLength) else { return }
    memcpy(mono.floatChannelData![0], channel, Int(buffer.frameLength) * 4)
    mono.frameLength = buffer.frameLength

    let capacity = AVAudioFrameCount(Double(buffer.frameLength) * 24000.0 / micFormat.sampleRate) + 32
    guard let converted = AVAudioPCMBuffer(pcmFormat: captureFormat, frameCapacity: capacity) else { return }
    var consumed = false
    converter.convert(to: converted, error: nil) { _, status in
      if consumed {
        status.pointee = .noDataNow
        return nil
      }
      consumed = true
      status.pointee = .haveData
      return mono
    }
    guard converted.frameLength > 0, let out = converted.int16ChannelData?[0] else { return }
    FileHandle.standardOutput.write(Data(bytes: out, count: Int(converted.frameLength) * 2))
  }

  do {
    try engine.start()
    log("input active (\(Int(micFormat.sampleRate))Hz, \(micFormat.channelCount)ch, echo cancellation \(voiceProcessing ? "on" : "off"))")
  } catch {
    if voiceProcessing {
      log("input engine failed with voice processing (\(error)) — retrying without")
      useAEC = false
      return startInput(voiceProcessing: false)
    }
    log("input engine failed: \(error)")
    scheduleRebuild("audio engines unavailable — retrying")
    return
  }

  // Watchdog: on some devices the voice-processed tap simply never fires.
  // Fall back to a plain tap; without VP the mic reliably delivers.
  if voiceProcessing {
    DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {
      if tapCount > 0 { return }
      log("voice-processed mic delivered nothing — restarting without echo cancellation")
      useAEC = false
      startInput(voiceProcessing: false)
    }
  }
}

// Voice processing is opt-in (--aec): it is only needed on speakers, and on
// some machines (observed with Bluetooth headsets active) the VP engine binds
// to the wrong capture device entirely, delivering noise instead of the mic.
// Mic first: activating the mic flips Bluetooth headsets from music mode to
// headset mode, reconfiguring the output device. Starting output afterwards
// (and rebuilding on any route change below) keeps playback on the live device.
startInput(voiceProcessing: useAEC)
startOutput()

// Device switches (Bluetooth profile flips, headphones plugged/unplugged,
// default device changes) stop engines silently. Rebuild both, debounced.
NotificationCenter.default.addObserver(
  forName: .AVAudioEngineConfigurationChange, object: nil, queue: .main
) { _ in
  if Date() < ignoreRouteChangesUntil { return }
  scheduleRebuild("audio route changed — rebuilding engines")
}

signal(SIGUSR1, SIG_IGN)
let flushSignal = DispatchSource.makeSignalSource(signal: SIGUSR1, queue: .main)
flushSignal.setEventHandler { queue.flush() }
flushSignal.resume()

DispatchQueue.global().async {
  while true {
    let chunk = FileHandle.standardInput.availableData
    if chunk.isEmpty { exit(0) } // parent closed stdin
    queue.push(chunk)
  }
}

RunLoop.main.run()
