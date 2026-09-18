import 'dart:math' as math;

import 'package:flutter/material.dart';

import 'link.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const JarvisApp());
}

const cyan = Color(0xFF5BD8FF);
const cyanDim = Color(0xFF1D6F8F);
const amber = Color(0xFFFFB648);
const bg = Color(0xFF04080D);
const panel = Color(0x80061420);
const edge = Color(0x305BD8FF);

class JarvisApp extends StatelessWidget {
  const JarvisApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'JARVIS',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        brightness: Brightness.dark,
        scaffoldBackgroundColor: bg,
        fontFamily: 'monospace',
        colorScheme: const ColorScheme.dark(primary: cyan, secondary: amber, surface: bg),
      ),
      home: const Home(),
    );
  }
}

class Home extends StatefulWidget {
  const Home({super.key});
  @override
  State<Home> createState() => _HomeState();
}

class _HomeState extends State<Home> {
  final link = JarvisLink();
  int tab = 0;

  @override
  void initState() {
    super.initState();
    link.loadPrefs();
    link.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    link.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final running = link.runningJobs.length;
    return Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            _Header(link: link),
            Expanded(
              child: IndexedStack(
                index: tab,
                children: [
                  VoiceView(link: link),
                  JobsView(link: link),
                  SessionsView(link: link, onResume: () => setState(() => tab = 0)),
                ],
              ),
            ),
          ],
        ),
      ),
      bottomNavigationBar: Container(
        decoration: const BoxDecoration(border: Border(top: BorderSide(color: edge))),
        child: BottomNavigationBar(
          currentIndex: tab,
          onTap: (i) {
            setState(() => tab = i);
            if (i == 1) link.refreshJobs();
            if (i == 2) link.refreshSessions();
          },
          backgroundColor: bg,
          selectedItemColor: cyan,
          unselectedItemColor: cyanDim,
          selectedFontSize: 10,
          unselectedFontSize: 10,
          type: BottomNavigationBarType.fixed,
          items: [
            const BottomNavigationBarItem(icon: Icon(Icons.graphic_eq, size: 20), label: 'VOICE'),
            BottomNavigationBarItem(
              icon: Badge(
                isLabelVisible: running > 0,
                backgroundColor: amber,
                label: Text('$running', style: const TextStyle(color: Colors.black, fontSize: 9)),
                child: const Icon(Icons.memory, size: 20),
              ),
              label: 'JOBS',
            ),
            const BottomNavigationBarItem(icon: Icon(Icons.history, size: 20), label: 'SESSIONS'),
          ],
        ),
      ),
    );
  }
}

class _Header extends StatelessWidget {
  const _Header({required this.link});
  final JarvisLink link;

  Future<void> _editHost(BuildContext context) async {
    final ctrl = TextEditingController(text: link.host);
    final v = await showDialog<String>(
      context: context,
      builder: (c) => AlertDialog(
        backgroundColor: const Color(0xFF07131D),
        title: const Text('HOST', style: TextStyle(color: cyan, fontSize: 14, letterSpacing: 3)),
        content: TextField(controller: ctrl, autofocus: true, style: const TextStyle(color: Colors.white)),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c), child: const Text('CANCEL')),
          TextButton(onPressed: () => Navigator.pop(c, ctrl.text.trim()), child: const Text('SAVE')),
        ],
      ),
    );
    if (v != null && v.isNotEmpty) link.setHost(v);
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 10, 16, 6),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          const Text('J.A.R.V.I.S',
              style: TextStyle(color: cyan, fontSize: 13, letterSpacing: 7, fontWeight: FontWeight.w500)),
          GestureDetector(
            onTap: () => _editHost(context),
            child: Row(children: [
              Container(
                width: 7,
                height: 7,
                margin: const EdgeInsets.only(right: 7),
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: link.live ? cyan : (link.state == LinkState.error ? const Color(0xFFFF6B6B) : cyanDim),
                ),
              ),
              Text(link.host, style: const TextStyle(color: cyanDim, fontSize: 11)),
            ]),
          ),
        ],
      ),
    );
  }
}

// ---------------------------------------------------------------- voice

class VoiceView extends StatefulWidget {
  const VoiceView({super.key, required this.link});
  final JarvisLink link;
  @override
  State<VoiceView> createState() => _VoiceViewState();
}

class _VoiceViewState extends State<VoiceView> with SingleTickerProviderStateMixin {
  late final AnimationController _spin =
      AnimationController(vsync: this, duration: const Duration(seconds: 12))..repeat();
  final _scroll = ScrollController();

  @override
  void dispose() {
    _spin.dispose();
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final link = widget.link;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) _scroll.jumpTo(_scroll.position.maxScrollExtent);
    });

    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SizedBox(
            height: 176,
            child: Center(
              child: AnimatedBuilder(
                animation: _spin,
                builder: (_, _) => CustomPaint(
                  size: const Size(176, 176),
                  painter: ReactorPainter(
                      turn: _spin.value, level: link.level, speaking: link.speaking, live: link.live),
                ),
              ),
            ),
          ),
          const SizedBox(height: 6),
          Text(link.status.toUpperCase(),
              textAlign: TextAlign.center,
              style: TextStyle(
                  color: link.state == LinkState.error ? const Color(0xFFFF6B6B) : (link.live ? cyan : cyanDim),
                  fontSize: 12,
                  letterSpacing: 2)),
          if (link.sessionName != null)
            Text('session · ${link.sessionName}',
                textAlign: TextAlign.center, style: const TextStyle(color: Color(0x905BD8FF), fontSize: 10)),
          Text(link.diag, textAlign: TextAlign.center, style: const TextStyle(color: Color(0x705BD8FF), fontSize: 10)),
          const SizedBox(height: 10),
          Expanded(
            child: Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(color: panel, border: Border.all(color: edge), borderRadius: BorderRadius.circular(12)),
              child: link.transcript.isEmpty
                  ? const Center(child: Text('transcript standby…', style: TextStyle(color: cyanDim, fontSize: 12)))
                  : ListView.builder(
                      controller: _scroll,
                      itemCount: link.transcript.length,
                      itemBuilder: (_, i) => LineView(link.transcript[i]),
                    ),
            ),
          ),
          const SizedBox(height: 10),
          Row(children: [
            Expanded(
              child: JButton(
                label: link.live ? 'END' : 'ENGAGE',
                color: link.live ? const Color(0xFFFF8585) : cyan,
                onTap: () => link.live ? link.disconnect() : link.connect(),
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: JButton(
                label: link.muted ? 'UNMUTE' : 'MUTE',
                color: link.muted ? amber : cyan,
                onTap: link.live ? link.toggleMute : null,
              ),
            ),
          ]),
        ],
      ),
    );
  }
}

// ---------------------------------------------------------------- jobs

class JobsView extends StatelessWidget {
  const JobsView({super.key, required this.link});
  final JarvisLink link;

  Color _stateColor(Job j) {
    switch (j.state) {
      case 'running':
      case 'queued':
        return amber;
      case 'done':
        return cyan;
      case 'failed':
        return const Color(0xFFFF6B6B);
      default:
        return cyanDim;
    }
  }

  @override
  Widget build(BuildContext context) {
    if (link.jobs.isEmpty) {
      return _Empty(
        icon: Icons.memory,
        text: link.live ? 'no jobs yet — ask for some work' : 'engage to see the agents at work',
      );
    }
    return RefreshIndicator(
      onRefresh: () async => link.refreshJobs(),
      backgroundColor: bg,
      color: cyan,
      child: ListView.builder(
        padding: const EdgeInsets.fromLTRB(16, 4, 16, 16),
        itemCount: link.jobs.length,
        itemBuilder: (context, i) {
          final j = link.jobs[i];
          final c = _stateColor(j);
          return GestureDetector(
            onTap: () => showModalBottomSheet(
              context: context,
              backgroundColor: const Color(0xFF07131D),
              isScrollControlled: true,
              builder: (_) => _JobSheet(job: j),
            ),
            child: Container(
              margin: const EdgeInsets.only(bottom: 10),
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: panel,
                border: Border.all(color: c.withValues(alpha: j.running ? 0.55 : 0.25)),
                borderRadius: BorderRadius.circular(10),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(children: [
                    if (j.running)
                      Container(
                        width: 7, height: 7,
                        margin: const EdgeInsets.only(right: 7),
                        decoration: const BoxDecoration(shape: BoxShape.circle, color: amber),
                      ),
                    Text('JOB ${j.id}', style: TextStyle(color: c, fontSize: 10, letterSpacing: 1.5)),
                    const Spacer(),
                    Text(j.state.toUpperCase(), style: TextStyle(color: c, fontSize: 10, letterSpacing: 1.5)),
                  ]),
                  const SizedBox(height: 6),
                  Text(j.task, maxLines: 2, overflow: TextOverflow.ellipsis,
                      style: const TextStyle(color: Colors.white, fontSize: 13, height: 1.35)),
                  const SizedBox(height: 8),
                  Wrap(spacing: 6, runSpacing: 6, children: [
                    _Chip(j.executor, cyan),
                    if (j.project != null) _Chip(j.project!, cyanDim),
                    if (j.branch != null) _Chip(j.branch!.split('/').last, cyanDim),
                    if (j.resumed) _Chip('resumed', amber),
                    if (j.continues != null) _Chip('continues ${j.continues}', amber),
                    if (j.merged) _Chip('merged', cyan),
                  ]),
                  if (j.running && j.lastBeat != null) ...[
                    const SizedBox(height: 8),
                    Text(j.lastBeat!, maxLines: 1, overflow: TextOverflow.ellipsis,
                        style: const TextStyle(color: amber, fontSize: 11)),
                  ],
                  if (!j.running && j.changes != null) ...[
                    const SizedBox(height: 8),
                    Text(j.changes!, style: const TextStyle(color: Color(0x905BD8FF), fontSize: 11)),
                  ],
                ],
              ),
            ),
          );
        },
      ),
    );
  }
}

class _JobSheet extends StatelessWidget {
  const _JobSheet({required this.job});
  final Job job;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.fromLTRB(18, 18, 18, MediaQuery.of(context).viewInsets.bottom + 24),
      child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text('JOB ${job.id} · ${job.state.toUpperCase()}',
            style: const TextStyle(color: cyan, fontSize: 12, letterSpacing: 2)),
        const SizedBox(height: 12),
        Text(job.task, style: const TextStyle(color: Colors.white, fontSize: 14, height: 1.4)),
        const SizedBox(height: 14),
        Wrap(spacing: 6, runSpacing: 6, children: [
          _Chip(job.executor, cyan),
          if (job.project != null) _Chip(job.project!, cyanDim),
          if (job.branch != null) _Chip(job.branch!, cyanDim),
          if (job.resumed) _Chip('resumed session', amber),
          if (job.merged) _Chip('merged', cyan),
        ]),
        if (job.changes != null) ...[
          const SizedBox(height: 14),
          Text(job.changes!, style: const TextStyle(color: amber, fontSize: 12)),
        ],
        if (job.summary != null) ...[
          const SizedBox(height: 14),
          const Text('REPORT', style: TextStyle(color: cyanDim, fontSize: 10, letterSpacing: 2)),
          const SizedBox(height: 6),
          ConstrainedBox(
            constraints: const BoxConstraints(maxHeight: 260),
            child: SingleChildScrollView(
              child: Text(job.summary!, style: const TextStyle(color: Color(0xFFCFEEFF), fontSize: 13, height: 1.45)),
            ),
          ),
        ],
      ]),
    );
  }
}

// ---------------------------------------------------------------- sessions

class SessionsView extends StatelessWidget {
  const SessionsView({super.key, required this.link, required this.onResume});
  final JarvisLink link;
  final VoidCallback onResume;

  String _ago(int ms) {
    final d = DateTime.now().difference(DateTime.fromMillisecondsSinceEpoch(ms));
    if (d.inMinutes < 1) return 'just now';
    if (d.inMinutes < 60) return '${d.inMinutes}m ago';
    if (d.inHours < 24) return '${d.inHours}h ago';
    return '${d.inDays}d ago';
  }

  @override
  Widget build(BuildContext context) {
    return Column(children: [
      Padding(
        padding: const EdgeInsets.fromLTRB(16, 4, 16, 10),
        child: JButton(
          label: 'NEW SESSION',
          color: cyan,
          onTap: () {
            if (link.live) link.disconnect();
            link.connect();
            onResume();
          },
        ),
      ),
      Expanded(
        child: link.sessions.isEmpty
            ? const _Empty(icon: Icons.history, text: 'no saved sessions yet')
            : RefreshIndicator(
                onRefresh: () async => link.refreshSessions(),
                backgroundColor: bg,
                color: cyan,
                child: ListView.builder(
                  padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
                  itemCount: link.sessions.length,
                  itemBuilder: (context, i) {
                    final s = link.sessions[i];
                    final current = s.id == link.sessionId;
                    return Dismissible(
                      key: ValueKey(s.id),
                      direction: DismissDirection.endToStart,
                      background: Container(
                        alignment: Alignment.centerRight,
                        padding: const EdgeInsets.only(right: 18, bottom: 10),
                        child: const Icon(Icons.delete_outline, color: Color(0xFFFF6B6B)),
                      ),
                      onDismissed: (_) => link.deleteSession(s.id),
                      child: GestureDetector(
                        onTap: () {
                          if (link.live) link.disconnect();
                          link.connect(resumeId: s.id);
                          onResume();
                        },
                        child: Container(
                          margin: const EdgeInsets.only(bottom: 10),
                          padding: const EdgeInsets.all(12),
                          decoration: BoxDecoration(
                            color: panel,
                            border: Border.all(color: current ? cyan.withValues(alpha: 0.6) : edge),
                            borderRadius: BorderRadius.circular(10),
                          ),
                          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                            Row(children: [
                              Expanded(
                                child: Text(s.name,
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                    style: TextStyle(color: current ? cyan : Colors.white, fontSize: 13)),
                              ),
                              Text(_ago(s.updatedAt), style: const TextStyle(color: cyanDim, fontSize: 10)),
                            ]),
                            if (s.preview.isNotEmpty) ...[
                              const SizedBox(height: 6),
                              Text(s.preview,
                                  maxLines: 2,
                                  overflow: TextOverflow.ellipsis,
                                  style: const TextStyle(color: Color(0x905BD8FF), fontSize: 11, height: 1.35)),
                            ],
                            const SizedBox(height: 8),
                            Row(children: [
                              _Chip('${s.turns} turns', cyanDim),
                              const SizedBox(width: 6),
                              if (s.jobs > 0) _Chip('${s.jobs} jobs', amber),
                              const Spacer(),
                              Text(current ? 'ACTIVE' : 'TAP TO RESUME',
                                  style: TextStyle(color: current ? cyan : cyanDim, fontSize: 9, letterSpacing: 1.5)),
                            ]),
                          ]),
                        ),
                      ),
                    );
                  },
                ),
              ),
      ),
    ]);
  }
}

// ---------------------------------------------------------------- shared

class LineView extends StatelessWidget {
  const LineView(this.line, {super.key});
  final Line line;

  @override
  Widget build(BuildContext context) {
    final isYou = line.who == 'you';
    final isTool = line.who == 'tool';
    final color = isYou ? cyan : (isTool ? const Color(0xFF8AA0AD) : amber);
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Container(
          margin: const EdgeInsets.only(right: 8, top: 2),
          padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
          decoration: BoxDecoration(border: Border.all(color: color.withValues(alpha: 0.5)), borderRadius: BorderRadius.circular(4)),
          child: Text(isYou ? 'YOU' : (isTool ? 'SYS' : 'JARVIS'), style: TextStyle(color: color, fontSize: 9, letterSpacing: 1)),
        ),
        Expanded(
          child: Text(line.text,
              style: TextStyle(
                  color: isTool ? const Color(0xFF8AA0AD) : (isYou ? const Color(0xFF9FD8F2) : Colors.white),
                  fontSize: 14,
                  height: 1.4)),
        ),
      ]),
    );
  }
}

class _Chip extends StatelessWidget {
  const _Chip(this.text, this.color);
  final String text;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
      decoration: BoxDecoration(border: Border.all(color: color.withValues(alpha: 0.45)), borderRadius: BorderRadius.circular(4)),
      child: Text(text, style: TextStyle(color: color, fontSize: 10)),
    );
  }
}

class JButton extends StatelessWidget {
  const JButton({super.key, required this.label, required this.color, this.onTap});
  final String label;
  final Color color;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final on = onTap != null;
    return GestureDetector(
      onTap: onTap,
      child: Container(
        height: 50,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: const Color(0xB30C2637),
          border: Border.all(color: color.withValues(alpha: on ? 0.6 : 0.2)),
          borderRadius: BorderRadius.circular(10),
        ),
        child: Text(label, style: TextStyle(color: color.withValues(alpha: on ? 1 : 0.4), fontSize: 13, letterSpacing: 3)),
      ),
    );
  }
}

class _Empty extends StatelessWidget {
  const _Empty({required this.icon, required this.text});
  final IconData icon;
  final String text;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        Icon(icon, color: cyanDim, size: 30),
        const SizedBox(height: 12),
        Text(text, style: const TextStyle(color: cyanDim, fontSize: 12)),
      ]),
    );
  }
}

/// The arc reactor: rings that spin, a core that breathes with the voice.
class ReactorPainter extends CustomPainter {
  ReactorPainter({required this.turn, required this.level, required this.speaking, required this.live});
  final double turn, level;
  final bool speaking, live;

  @override
  void paint(Canvas canvas, Size size) {
    final c = Offset(size.width / 2, size.height / 2);
    final r = size.width / 2;
    final tint = speaking ? amber : cyan;

    void ring(double radius, double width, double opacity, double sweep, double phase) {
      canvas.drawArc(
        Rect.fromCircle(center: c, radius: radius),
        phase,
        sweep,
        false,
        Paint()
          ..style = PaintingStyle.stroke
          ..strokeWidth = width
          ..strokeCap = StrokeCap.round
          ..color = tint.withValues(alpha: live ? opacity : opacity * 0.4),
      );
    }

    ring(r * 0.96, 1, 0.25, math.pi * 2, 0);
    ring(r * 0.86, 2, 0.8, 1.6, turn * math.pi * 2);
    ring(r * 0.86, 2, 0.35, 1.0, turn * math.pi * 2 + math.pi);
    ring(r * 0.72, 1.5, 0.5, 2.4, -turn * math.pi * 2 * 0.7);
    ring(r * 0.60, 1, 0.3, math.pi * 2, 0);

    final beat = speaking ? 0.5 + 0.5 * math.sin(turn * math.pi * 8) : level;
    final coreR = r * (0.30 + beat * 0.13);
    canvas.drawCircle(
        c,
        coreR + 18,
        Paint()
          ..color = tint.withValues(alpha: live ? 0.22 : 0.06)
          ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 22));
    canvas.drawCircle(
        c,
        coreR,
        Paint()
          ..shader = RadialGradient(colors: [Colors.white, tint, tint.withValues(alpha: 0.15)], stops: const [0, 0.55, 1])
              .createShader(Rect.fromCircle(center: c, radius: coreR)));
  }

  @override
  bool shouldRepaint(ReactorPainter old) =>
      old.turn != turn || old.level != level || old.speaking != speaking || old.live != live;
}
