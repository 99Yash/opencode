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
  private var data = Data()
  private let lock = NSLock()
  func push(_ chunk: Data) {
    lock.lock()
    data.append(chunk)
    lock.unlock()
  }
  func pop(frames: Int) -> [Int16] {
    lock.lock()
    defer { lock.unlock() }
    let bytes = min(frames * 2, data.count - data.count % 2)
    var samples = [Int16](repeating: 0, count: frames)
    data.prefix(bytes).withUnsafeBytes { raw in
      let int16 = raw.bindMemory(to: Int16.self)
      for i in 0..<int16.count { samples[i] = int16[i] }
    }
    data.removeFirst(bytes)
    return samples
  }
  func flush() {
    lock.lock()
    data.removeAll()
    lock.unlock()
  }
}

let queue = SpeakerQueue()
let playFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 24000, channels: 1, interleaved: false)!
let captureFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 24000, channels: 1, interleaved: true)!

// Speaker: its own engine, pulling PCM16 from the stdin-fed queue.
var outputEngine: AVAudioEngine?

func startOutput() {
  outputEngine?.stop()
  let engine = AVAudioEngine()
  outputEngine = engine
  let source = AVAudioSourceNode(format: playFormat) { _, _, frameCount, audioBufferList -> OSStatus in
    let samples = queue.pop(frames: Int(frameCount))
    let out = UnsafeMutableAudioBufferListPointer(audioBufferList)[0].mData!.assumingMemoryBound(to: Float.self)
    for i in 0..<Int(frameCount) { out[i] = Float(samples[i]) / 32768.0 }
    return noErr
  }
  engine.attach(source)
  engine.connect(source, to: engine.mainMixerNode, format: playFormat)
  do {
    try engine.start()
  } catch {
    log("output engine failed: \(error)")
  }
}

// Microphone: take channel 0 of whatever the hardware provides, resample to
// 24kHz PCM16 for stdout. Channel extraction is manual because hardware
// channel counts vary wildly (1, 2, 3, 22...) and AVAudioConverter cannot
// downmix all of them.
var tapCount = 0
var inputEngine: AVAudioEngine?

func startInput(voiceProcessing: Bool) {
  inputEngine?.stop()
  let engine = AVAudioEngine()
  inputEngine = engine
  if voiceProcessing {
    do {
      try engine.inputNode.setVoiceProcessingEnabled(true)
    } catch {
      log("voice processing unavailable (\(error)) — no echo cancellation")
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
  let monoFormat = AVAudioFormat(
    commonFormat: .pcmFormatFloat32, sampleRate: micFormat.sampleRate, channels: 1, interleaved: false)!
  guard let converter = AVAudioConverter(from: monoFormat, to: captureFormat) else {
    log("cannot convert \(micFormat.sampleRate)Hz to 24kHz")
    exit(2)
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
  } catch {
    if voiceProcessing {
      log("input engine failed with voice processing (\(error)) — retrying without")
      return startInput(voiceProcessing: false)
    }
    log("input engine failed: \(error)")
    exit(2)
  }

  // Watchdog: on some devices the voice-processed tap simply never fires.
  // Fall back to a plain tap; without VP the mic reliably delivers.
  if voiceProcessing {
    DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {
      if tapCount > 0 { return }
      log("voice-processed mic delivered nothing — restarting without echo cancellation")
      startInput(voiceProcessing: false)
    }
  }
}

// Voice processing is opt-in (--aec): it is only needed on speakers, and on
// some machines (observed with Bluetooth headsets active) the VP engine binds
// to the wrong capture device entirely, delivering noise instead of the mic.
let wantAEC = CommandLine.arguments.contains("--aec")

// Mic first: activating the mic flips Bluetooth headsets from music mode to
// headset mode, reconfiguring the output device. Starting output afterwards
// (and rebuilding on any route change below) keeps playback on the live device.
startInput(voiceProcessing: wantAEC)
startOutput()

// Device switches (Bluetooth profile flips, headphones plugged/unplugged,
// default device changes) stop engines silently. Rebuild both, debounced.
var rebuildScheduled = false
NotificationCenter.default.addObserver(
  forName: .AVAudioEngineConfigurationChange, object: nil, queue: .main
) { _ in
  if rebuildScheduled { return }
  rebuildScheduled = true
  DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
    rebuildScheduled = false
    log("audio route changed — rebuilding engines")
    startInput(voiceProcessing: wantAEC)
    startOutput()
  }
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
