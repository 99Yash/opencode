// Full-duplex terminal audio bridge with Apple voice processing (AEC).
//
//   stdin  <- raw PCM16 mono 24kHz to play through the speakers
//   stdout -> raw PCM16 mono 24kHz captured from the microphone,
//             echo-cancelled against the audio this process plays
//   SIGUSR1: drop any queued speaker audio (barge-in flush)
//
// Compiled on demand by spike.ts: swiftc -O duplex-audio.swift -o duplex-audio

import AVFoundation

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
let engine = AVAudioEngine()

do {
  // Enables Apple's voice-processed IO unit (acoustic echo cancellation) on
  // both sides of this engine. Conveniently it runs at 24kHz natively.
  try engine.inputNode.setVoiceProcessingEnabled(true)
} catch {
  FileHandle.standardError.write(Data("voice processing unavailable: \(error)\n".utf8))
  exit(2)
}
if #available(macOS 14.0, *) {
  // Don't duck other system audio while the mic is hot.
  engine.inputNode.voiceProcessingOtherAudioDuckingConfiguration = .init(
    enableAdvancedDucking: false,
    duckingLevel: .min
  )
}

let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 24000, channels: 1, interleaved: false)!

// Speaker: pull PCM16 from the stdin-fed queue, emit silence when empty.
let source = AVAudioSourceNode(format: format) { _, _, frameCount, audioBufferList -> OSStatus in
  let samples = queue.pop(frames: Int(frameCount))
  let out = UnsafeMutableAudioBufferListPointer(audioBufferList)[0].mData!.assumingMemoryBound(to: Float.self)
  for i in 0..<Int(frameCount) { out[i] = Float(samples[i]) / 32768.0 }
  return noErr
}
engine.attach(source)
// Directly to the output node: with voice processing enabled it runs mono
// 24kHz, and routing through mainMixerNode (stereo 44.1k) fails AU init.
engine.connect(source, to: engine.outputNode, format: format)

// Microphone: convert the hardware format to PCM16 mono 24kHz for stdout.
let target = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 24000, channels: 1, interleaved: true)!
let micFormat = engine.inputNode.outputFormat(forBus: 0)
let converter = AVAudioConverter(from: micFormat, to: target)!

engine.inputNode.installTap(onBus: 0, bufferSize: 2400, format: micFormat) { buffer, _ in
  let capacity = AVAudioFrameCount(Double(buffer.frameLength) * 24000.0 / micFormat.sampleRate) + 32
  guard let converted = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return }
  var consumed = false
  converter.convert(to: converted, error: nil) { _, status in
    if consumed {
      status.pointee = .noDataNow
      return nil
    }
    consumed = true
    status.pointee = .haveData
    return buffer
  }
  guard converted.frameLength > 0, let channel = converted.int16ChannelData?[0] else { return }
  FileHandle.standardOutput.write(Data(bytes: channel, count: Int(converted.frameLength) * 2))
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

try engine.start()
RunLoop.main.run()
