package com.jarvis.jarvis_phone

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import android.media.*
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.AutomaticGainControl
import android.media.audiofx.NoiseSuppressor
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodChannel
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

// Voice I/O for the realtime link: 16 kHz PCM16 up, 24 kHz PCM16 down,
// with the platform's hardware echo canceller so the user can interrupt mid-sentence.
class MainActivity : FlutterActivity() {
    private val methodChannel = "jarvis/audio"
    private val micChannel = "jarvis/mic"

    private val inputRate = 16000
    private val outputRate = 24000

    private var record: AudioRecord? = null
    private var track: AudioTrack? = null
    private var capturing = false
    private var muted = false
    private var micSink: EventChannel.EventSink? = null
    private var effects = mutableListOf<android.media.audiofx.AudioEffect>()
    private var speaker = true
    private var bytesPlayed = 0L
    private var aecOn = false
    // The model streams a reply faster than it plays. Queue it and let a writer thread
    // drain at the speed of sound, or AudioTrack silently drops everything past its buffer.
    private val playQueue = LinkedBlockingQueue<ByteArray>()
    private var dropped = 0L
    @Volatile private var playing = false
    // While the speaker is active the microphone hears JARVIS. Anything quieter than
    // the barge-in bar during that window is treated as echo and never leaves the phone.
    @Volatile private var speakingUntilMs = 0L
    private val echoTailMs = 250L
    private val bargeInPeak = 7000 // ~ -13 dBFS: a real voice over the speaker, not its leakage
    private val am by lazy { getSystemService(AUDIO_SERVICE) as AudioManager }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Ask once at launch so ENGAGE never stalls on a permission dialog.
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.RECORD_AUDIO), 1001)
        }
        volumeControlStream = AudioManager.STREAM_VOICE_CALL
    }

    override fun configureFlutterEngine(engine: FlutterEngine) {
        super.configureFlutterEngine(engine)

        EventChannel(engine.dartExecutor.binaryMessenger, micChannel).setStreamHandler(
            object : EventChannel.StreamHandler {
                override fun onListen(args: Any?, sink: EventChannel.EventSink?) { micSink = sink }
                override fun onCancel(args: Any?) { micSink = null }
            },
        )

        MethodChannel(engine.dartExecutor.binaryMessenger, methodChannel).setMethodCallHandler { call, result ->
            when (call.method) {
                "start" -> {
                    if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                        ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.RECORD_AUDIO), 1001)
                        result.error("no_permission", "microphone permission not granted", null)
                    } else {
                        startAudio(); result.success(true)
                    }
                }
                "stop" -> { stopAudio(); result.success(true) }
                "mute" -> { muted = call.argument<Boolean>("value") ?: false; result.success(true) }
                "play" -> {
                    val bytes = call.argument<ByteArray>("pcm")
                    if (bytes != null && track != null) {
                        playQueue.put(bytes)
                        bytesPlayed += bytes.size
                        // 24 kHz, 16-bit mono => 48000 bytes per second of speech.
                        val ms = bytes.size * 1000L / 48000L
                        speakingUntilMs = maxOf(speakingUntilMs, System.currentTimeMillis()) + ms
                    }
                    // The Dart side surfaces this, so silence is diagnosable from the phone.
                    result.success(mapOf("queued" to playQueue.size, "total" to bytesPlayed, "dropped" to dropped))
                }
                "speaker" -> {
                    speaker = call.argument<Boolean>("value") ?: true
                    routeAudio()
                    result.success(speaker)
                }
                "clear" -> { // barge-in: drop everything still queued for playback
                    playQueue.clear()
                    track?.let { t ->
                        try { t.pause(); t.flush(); t.play() } catch (_: Exception) {}
                    }
                    speakingUntilMs = 0
                    result.success(true)
                }
                "status" -> result.success(mapOf("aec" to aecOn, "speaker" to speaker, "played" to bytesPlayed, "queued" to playQueue.size))
                else -> result.notImplemented()
            }
        }
    }

    // Voice-communication audio defaults to the earpiece. Put the phone in communication
    // mode and force the loudspeaker, or JARVIS talks into a receiver nobody is holding.
    private fun routeAudio() {
        try {
            am.mode = AudioManager.MODE_IN_COMMUNICATION
            if (Build.VERSION.SDK_INT >= 31) {
                val target = if (speaker) AudioDeviceInfo.TYPE_BUILTIN_SPEAKER else AudioDeviceInfo.TYPE_BUILTIN_EARPIECE
                am.availableCommunicationDevices.firstOrNull { it.type == target }?.let { am.setCommunicationDevice(it) }
            } else {
                @Suppress("DEPRECATION")
                am.isSpeakerphoneOn = speaker
            }
        } catch (_: Exception) {}
    }

    private fun startAudio() {
        if (capturing) return
        routeAudio()

        val outBuf = AudioTrack.getMinBufferSize(
            outputRate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT,
        ).coerceAtLeast(outputRate * 2) * 2 // ~2 s of headroom
        track = AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build(),
            )
            .setAudioFormat(
                AudioFormat.Builder()
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setSampleRate(outputRate)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                    .build(),
            )
            .setBufferSizeInBytes(outBuf)
            .setTransferMode(AudioTrack.MODE_STREAM)
            .build()
        track?.play()

        playing = true
        thread(name = "jarvis-speaker") {
            while (playing || playQueue.isNotEmpty()) {
                val chunk = playQueue.poll(200, TimeUnit.MILLISECONDS) ?: continue
                var off = 0
                while (off < chunk.size) {
                    // Blocking writes apply back-pressure instead of discarding the tail.
                    val n = track?.write(chunk, off, chunk.size - off, AudioTrack.WRITE_BLOCKING) ?: -1
                    if (n <= 0) { dropped += (chunk.size - off); break }
                    off += n
                }
            }
        }

        val inBuf = AudioRecord.getMinBufferSize(
            inputRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT,
        ).coerceAtLeast(inputRate)
        record = AudioRecord(
            MediaRecorder.AudioSource.VOICE_COMMUNICATION, // the source the AEC is wired to
            inputRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, inBuf * 2,
        )

        record?.audioSessionId?.let { id ->
            if (AcousticEchoCanceler.isAvailable()) AcousticEchoCanceler.create(id)?.also { it.enabled = true; aecOn = it.enabled; effects.add(it) }
            if (NoiseSuppressor.isAvailable()) NoiseSuppressor.create(id)?.also { it.enabled = true; effects.add(it) }
            if (AutomaticGainControl.isAvailable()) AutomaticGainControl.create(id)?.also { it.enabled = true; effects.add(it) }
        }

        record?.startRecording()
        capturing = true

        // 60 ms frames, matching what the realtime API likes to receive.
        val frame = ByteArray(inputRate * 2 * 60 / 1000)
        thread(name = "jarvis-mic") {
            while (capturing) {
                val n = record?.read(frame, 0, frame.size) ?: -1
                if (n <= 0) continue
                val chunk = frame.copyOf(n)

                // Peak of this frame, used to tell a real interruption from speaker leakage.
                var peak = 0
                var i = 0
                while (i + 1 < n) {
                    val v = ((chunk[i + 1].toInt() shl 8) or (chunk[i].toInt() and 0xFF)).toShort().toInt()
                    val a = if (v < 0) -v else v
                    if (a > peak) peak = a
                    i += 2
                }

                val echoWindow = System.currentTimeMillis() < speakingUntilMs + echoTailMs
                if (muted || (echoWindow && peak < bargeInPeak)) java.util.Arrays.fill(chunk, 0)

                val sink = micSink ?: continue
                runOnUiThread { sink.success(chunk) }
            }
        }
    }

    private fun stopAudio() {
        capturing = false
        playing = false
        playQueue.clear()
        try {
            if (Build.VERSION.SDK_INT >= 31) am.clearCommunicationDevice()
            am.mode = AudioManager.MODE_NORMAL
        } catch (_: Exception) {}
        try { record?.stop() } catch (_: Exception) {}
        record?.release(); record = null
        effects.forEach { try { it.release() } catch (_: Exception) {} }
        effects.clear()
        try { track?.stop() } catch (_: Exception) {}
        track?.release(); track = null

        val audioManager = getSystemService(AUDIO_SERVICE) as AudioManager
        audioManager.isSpeakerphoneOn = false
        audioManager.mode = AudioManager.MODE_NORMAL
    }

    override fun onDestroy() {
        stopAudio()
        super.onDestroy()
    }
}
