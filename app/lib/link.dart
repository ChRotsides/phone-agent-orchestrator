import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:web_socket_channel/io.dart';

enum LinkState { offline, connecting, online, error }

class Line {
  Line(this.who, this.text, {this.at});
  final String who; // you | jarvis | tool
  String text;
  final int? at;
}

class Job {
  Job.fromJson(Map<String, dynamic> j)
      : id = j['id'] ?? '',
        state = j['state'] ?? '',
        executor = j['executor'] ?? '',
        project = j['project'],
        task = j['task'] ?? '',
        branch = j['branch'],
        lastBeat = j['lastBeat'],
        changes = j['changes'],
        summary = j['summary'],
        resumed = j['resumed'] == true,
        continues = j['continues'],
        merged = j['merged'] == true,
        createdAt = j['createdAt'],
        finishedAt = j['finishedAt'];

  final String id, state, executor, task;
  final String? project, branch, lastBeat, changes, summary, continues;
  final bool resumed, merged;
  final int? createdAt, finishedAt;

  bool get running => state == 'running' || state == 'queued';
}

class SessionSummary {
  SessionSummary.fromJson(Map<String, dynamic> j)
      : id = j['id'] ?? '',
        name = j['name'] ?? '',
        turns = j['turns'] ?? 0,
        jobs = j['jobs'] ?? 0,
        preview = j['preview'] ?? '',
        updatedAt = j['updatedAt'] ?? 0;

  final String id, name, preview;
  final int turns, jobs, updatedAt;
}

/// Owns the websocket, the native audio engine and everything the UI renders.
class JarvisLink extends ChangeNotifier {
  static const _audio = MethodChannel('jarvis/audio');
  static const _mic = EventChannel('jarvis/mic');

  IOWebSocketChannel? _ws;
  StreamSubscription? _micSub;

  LinkState state = LinkState.offline;
  String status = 'offline';
  String diag = '';
  String host = '192.168.0.226:8443';
  bool muted = false;
  bool speaker = true;
  bool aec = false;
  bool speaking = false;
  int audioBytes = 0;
  double level = 0;
  int _frames = 0;

  final List<Line> transcript = [];
  // Where the reply being streamed right now lives, so each response is its own
  // bubble and a late transcription can be slotted in above it.
  int? _replyAt;
  List<Job> jobs = [];
  List<SessionSummary> sessions = [];
  String? sessionId;
  String? sessionName;
  Map<String, dynamic>? openedSession;

  bool get live => state == LinkState.online;
  List<Job> get runningJobs => jobs.where((j) => j.running).toList();

  Future<void> loadPrefs() async {
    final p = await SharedPreferences.getInstance();
    host = p.getString('host') ?? host;
    notifyListeners();
  }

  Future<void> setHost(String value) async {
    host = value;
    (await SharedPreferences.getInstance()).setString('host', value);
    notifyListeners();
  }

  /// [resumeId] continues a saved session; otherwise a new one is started.
  Future<void> connect({String? resumeId, String? name}) async {
    _set(LinkState.connecting, 'linking…');
    try {
      final client = HttpClient()..badCertificateCallback = (_, _, _) => true;
      final ws = IOWebSocketChannel.connect(
        Uri.parse('wss://$host/rt'),
        customClient: client,
        pingInterval: const Duration(seconds: 20),
      );
      _ws = ws;
      await ws.ready;

      ws.stream.listen(_onEvent, onDone: _onClosed, onError: (e) => _fail('$e'));
      send({'type': 'jarvis.session.start', if (resumeId != null) 'id': resumeId, if (name != null) 'name': name});

      await _audio.invokeMethod('start');
      _audio.invokeMethod('status').then((r) {
        if (r is Map) {
          aec = r['aec'] == true;
          notifyListeners();
        }
      }).catchError((Object _) {});
      _micSub = _mic.receiveBroadcastStream().listen(_onMicChunk);

      if (resumeId == null) transcript.clear();
      _set(LinkState.online, 'online — speak, sir');
    } catch (e) {
      _fail('$e');
    }
  }

  void disconnect() {
    _micSub?.cancel();
    _micSub = null;
    _audio.invokeMethod('stop');
    _ws?.sink.close();
    _ws = null;
    speaking = false;
    _set(LinkState.offline, 'offline');
  }

  void send(Map<String, dynamic> msg) {
    try {
      _ws?.sink.add(jsonEncode(msg));
    } catch (_) {}
  }

  void toggleSpeaker() {
    speaker = !speaker;
    _audio.invokeMethod('speaker', {'value': speaker});
    notifyListeners();
  }

  void toggleMute() {
    muted = !muted;
    _audio.invokeMethod('mute', {'value': muted});
    notifyListeners();
  }

  void refreshJobs() {
    send({'type': 'jarvis.jobs.refresh'});
    _fetch('/api/jobs').then((data) {
      if (data is List && (data.isNotEmpty || jobs.isEmpty)) {
        jobs = data.reversed.map((j) => Job.fromJson(j as Map<String, dynamic>)).toList();
        notifyListeners();
      }
    });
  }

  void refreshSessions() {
    send({'type': 'jarvis.session.list'});
    _fetch('/api/sessions').then((data) {
      if (data is List && (data.isNotEmpty || sessions.isEmpty)) {
        sessions = data.map((s) => SessionSummary.fromJson(s as Map<String, dynamic>)).toList();
        notifyListeners();
      }
    });
  }

  /// Plain REST against the host, independent of the voice websocket.
  Future<dynamic> _fetch(String path) async {
    try {
      final client = HttpClient()..connectionTimeout = const Duration(seconds: 6);
      client.badCertificateCallback = (_, _, _) => true;
      final req = await client.getUrl(Uri.parse('https://$host$path'));
      final res = await req.close();
      final body = await res.transform(utf8.decoder).join();
      client.close();
      return jsonDecode(body);
    } catch (e) {
      diag = 'host unreachable: ${e.toString().split(':').first}';
      notifyListeners();
      return null;
    }
  }
  void openSession(String id) => send({'type': 'jarvis.session.open', 'id': id});
  void renameSession(String id, String name) => send({'type': 'jarvis.session.rename', 'id': id, 'name': name});
  void deleteSession(String id) => send({'type': 'jarvis.session.delete', 'id': id});

  void _onMicChunk(dynamic data) {
    if (data is! Uint8List) return;
    _frames++;
    var peak = 0;
    for (var i = 0; i + 1 < data.length; i += 64) {
      final s = (data[i + 1] << 8) | data[i];
      final v = (s > 32767 ? s - 65536 : s).abs();
      if (v > peak) peak = v;
    }
    final lvl = (peak / 32768).clamp(0.0, 1.0);
    if ((lvl - level).abs() > 0.02) {
      level = lvl;
      notifyListeners();
    }
    if (_frames % 16 == 0) {
      diag = 'mic ${(20 * math.log(lvl + 1e-6) / math.ln10).toStringAsFixed(0)} dB · $_frames frames';
    }
    send({'type': 'input_audio_buffer.append', 'audio': base64Encode(data)});
  }

  void _onEvent(dynamic raw) {
    final e = jsonDecode(raw as String) as Map<String, dynamic>;
    switch (e['type']) {
      case 'response.audio.delta':
        final pcm = base64Decode(e['delta'] as String);
        _audio.invokeMethod('play', {'pcm': pcm}).then((r) {
          // Surfacing what the speaker actually accepted turns silence into a number.
          if (r is Map && r['total'] is int) {
            audioBytes = r['total'] as int;
            final lost = r['dropped'];
            if (lost is int && lost > 0) diag = 'audio dropped ${lost}B';
          }
        }).catchError((Object e) {
          diag = 'audio error: $e';
          notifyListeners();
        });
        if (!speaking) {
          speaking = true;
          notifyListeners();
        }
        break;
      case 'response.audio.done':
      case 'response.done':
        _replyAt = null;
        speaking = false;
        status = 'online — speak, sir';
        notifyListeners();
        break;
      case 'input_audio_buffer.speech_started':
        _audio.invokeMethod('clear'); // barge-in
        speaking = false;
        status = 'listening…';
        notifyListeners();
        break;
      case 'input_audio_buffer.speech_stopped':
        status = 'thinking…';
        notifyListeners();
        break;
      case 'conversation.item.input_audio_transcription.completed':
        // Speech recognition finishes after JARVIS has begun replying, so the line
        // belongs above the answer it prompted, not below it.
        final said = (e['transcript'] as String?)?.trim() ?? '';
        if (said.isEmpty) break;
        if (_replyAt != null && _replyAt! <= transcript.length) {
          transcript.insert(_replyAt!, Line('you', said));
          _replyAt = _replyAt! + 1;
          notifyListeners();
        } else {
          _addLine('you', said);
        }
        break;
      case 'response.created':
        _replyAt = null; // next delta opens a fresh bubble
        break;
      case 'response.audio_transcript.delta':
        _appendAssistant(e['delta'] as String);
        break;
      case 'response.audio_transcript.done':
        // The final transcript is authoritative; streamed deltas can drop fragments.
        final full = (e['transcript'] as String?)?.trim() ?? '';
        if (_replyAt != null && full.isNotEmpty && _replyAt! < transcript.length) {
          transcript[_replyAt!].text = full;
          notifyListeners();
        } else if (full.isNotEmpty && _replyAt == null) {
          _addLine('jarvis', full);
        }
        _replyAt = null;
        break;
      case 'jarvis.tool':
        final p = e['args']?['project'];
        _addLine('tool', '${e['name']}${p != null ? ' · $p' : ''}');
        break;
      case 'jarvis.tool_result':
        diag = '${e['name']}: ${e['result']?['ok'] == true ? 'ok' : 'refused'}';
        notifyListeners();
        break;
      case 'jarvis.session':
        final s = e['session'];
        if (s != null) {
          final isNewSession = sessionId != s['id'];
          sessionId = s['id'];
          sessionName = s['name'];
          if (isNewSession || transcript.isEmpty) {
            transcript
              ..clear()
              ..addAll(((s['lines'] ?? []) as List).map((l) => Line(l['who'], l['text'], at: l['at'])));
            _replyAt = null;
          }
          notifyListeners();
        }
        break;
      case 'jarvis.sessions':
        sessions = ((e['sessions'] ?? []) as List).map((s) => SessionSummary.fromJson(s)).toList();
        notifyListeners();
        break;
      case 'jarvis.session.detail':
        openedSession = e['session'];
        notifyListeners();
        break;
      case 'jarvis.jobs':
        jobs = ((e['jobs'] ?? []) as List).map((j) => Job.fromJson(j)).toList();
        notifyListeners();
        break;
      case 'error':
        _addLine('tool', 'error: ${e['error']?['message']}');
        break;
    }
  }

  void _appendAssistant(String delta) {
    if (_replyAt == null || _replyAt! >= transcript.length) {
      transcript.add(Line('jarvis', delta));
      _replyAt = transcript.length - 1;
    } else {
      transcript[_replyAt!].text += delta;
    }
    notifyListeners();
  }

  void _addLine(String who, String text) {
    if (text.trim().isEmpty) return;
    transcript.add(Line(who, text));
    notifyListeners();
  }

  void _set(LinkState s, String msg) {
    state = s;
    status = msg;
    notifyListeners();
  }

  void _fail(String msg) {
    _set(LinkState.error, 'link failed: ${msg.split('\n').first}');
    disconnect();
  }

  void _onClosed() {
    if (state != LinkState.offline) _set(LinkState.offline, 'link closed');
  }

  @override
  void dispose() {
    disconnect();
    super.dispose();
  }
}
