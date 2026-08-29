const express = require('express');
const multer = require('multer');
const archiver = require('archiver');
const ffmpegPath = require('ffmpeg-static');
const { spawn } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const app = express();
const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const UPLOADS = path.join(DATA, 'uploads');
const OUTPUTS = path.join(DATA, 'outputs');
const PY_BIN = path.join(ROOT, '.venv', 'bin');
const YTDLP = path.join(PY_BIN, 'yt-dlp');
const DEMUCS = path.join(PY_BIN, 'demucs');
const jobs = new Map();

for (const dir of [DATA, UPLOADS, OUTPUTS]) fs.mkdirSync(dir, { recursive: true });
const upload = multer({
  dest: UPLOADS,
  limits: { fileSize: 250 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null,
    /^audio\//.test(file.mimetype) || /^video\//.test(file.mimetype) ||
    /\.(mp3|m4a|aac|wav|flac|ogg|opus|webm|mp4|mov)$/i.test(file.originalname))
});

app.use(express.json({ limit: '1mb' }));
app.get('/', (_req, res) => res.sendFile(path.join(ROOT, 'main.html')));
app.use('/jobs', express.static(OUTPUTS, { fallthrough: false, maxAge: '1h' }));

function run(cmd, args, options = {}, onLine, timeoutMs = 0) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    let timer;
    const collect = chunk => {
      const text = chunk.toString();
      log = (log + text).slice(-12000);
      if (onLine) onLine(text);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    if (timeoutMs) timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 3000).unref();
      reject(new Error(`หมดเวลารอการประมวลผล (${Math.round(timeoutMs / 60000)} นาที)\n${log}`));
    }, timeoutMs);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      code === 0 ? resolve(log) : reject(new Error(log || `${cmd} exited ${code}`));
    });
  });
}

function youtubeUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'music.youtube.com'].includes(u.hostname);
  } catch { return false; }
}

function safeName(name) {
  return (name || 'track').replace(/[^\p{L}\p{N} ._-]/gu, '').slice(0, 80).trim() || 'track';
}

function publicJob(job) {
  return { id: job.id, status: job.status, progress: job.progress, message: job.message, title: job.title, error: job.error, stems: job.stems, key: job.key, duration: job.duration };
}

async function durationOf(file) {
  const ffprobe = ffmpegPath.replace(/ffmpeg$/, 'ffprobe');
  if (fs.existsSync(ffprobe)) {
    try { return Number((await run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file])).trim()); }
    catch { return null; }
  }
  try { await run(ffmpegPath, ['-i', file, '-f', 'null', '-']); return null; }
  catch (error) {
    const match = error.message.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : null;
  }
}

async function processJob(job, source) {
  const jobDir = path.join(OUTPUTS, job.id);
  await fsp.mkdir(jobDir, { recursive: true });
  try {
    let input = source.file;
    if (source.url) {
      job.status = 'downloading'; job.progress = 6; job.message = 'กำลังดาวน์โหลดเสียงจาก YouTube';
      const template = path.join(jobDir, 'source.%(ext)s');
      await run(YTDLP, [
        '--no-playlist', '--newline', '--progress', '--socket-timeout', '20', '--retries', '3',
        '--fragment-retries', '3', '--concurrent-fragments', '4', '--max-filesize', '250M',
        '--match-filter', 'duration <= 900', '--write-info-json', '-x', '--audio-format', 'wav',
        '--audio-quality', '0', '--ffmpeg-location', ffmpegPath, '-o', template, source.url
      ], {}, text => {
        const matches = [...text.matchAll(/(\d+(?:\.\d+)?)%/g)];
        if (matches.length) {
          const percent = Number(matches.at(-1)[1]);
          job.progress = Math.min(28, 5 + percent * .23);
          job.message = percent >= 100 ? 'กำลังแปลงเสียงเป็น WAV' : `กำลังดาวน์โหลดเสียงจาก YouTube (${Math.round(percent)}%)`;
        } else if (/ExtractAudio|Destination:.*\.wav/i.test(text)) {
          job.progress = 29; job.message = 'กำลังแปลงเสียงเป็น WAV';
        }
      }, 10 * 60 * 1000);
      input = path.join(jobDir, 'source.wav');
      try {
        const info = JSON.parse(await fsp.readFile(path.join(jobDir, 'source.info.json'), 'utf8'));
        job.title = safeName(info.title);
      } catch { job.title = 'YouTube Track'; }
    } else {
      job.title = safeName(source.title);
      input = path.join(jobDir, 'source' + (path.extname(source.title) || '.audio'));
      await fsp.rename(source.file, input);
    }
    if (!fs.existsSync(input)) throw new Error('ไม่พบไฟล์เสียงหลังการนำเข้า');
    const duration = await durationOf(input);
    if (duration && duration > 900) throw new Error('เพลงยาวเกิน 15 นาที');
    job.status = 'analyzing'; job.progress = 30; job.message = 'กำลังตรวจจับคีย์ดนตรี';
    const analysisWav = path.join(jobDir, 'key-analysis.wav');
    await run(ffmpegPath, ['-y', '-i', input, '-t', '180', '-ac', '1', '-ar', '22050', '-c:a', 'pcm_s16le', analysisWav]);
    try { job.key = JSON.parse((await run(path.join(PY_BIN, 'python'), [path.join(ROOT, 'key_detect.py'), analysisWav])).trim()); }
    catch { job.key = { key: 'ไม่ทราบ', tonic: 0, mode: 'unknown', confidence: 0 }; }
    await fsp.rm(analysisWav, { force: true });
    job.status = 'separating'; job.progress = 32; job.message = 'AI กำลังแยกเสียง 6 แทร็ก (ครั้งแรกจะดาวน์โหลดโมเดล)';
    const env = { ...process.env, PATH: `${path.dirname(ffmpegPath)}:${PY_BIN}:${process.env.PATH || ''}` };
    await run(DEMUCS, ['-n', 'htdemucs_6s', '--float32', '-o', jobDir, input], { env }, text => {
      const matches = [...text.matchAll(/(\d+)%\|/g)];
      if (matches.length) job.progress = 32 + Number(matches.at(-1)[1]) * .58;
    }, 2 * 60 * 60 * 1000);
    const modelDir = path.join(jobDir, 'htdemucs_6s');
    const trackDirs = await fsp.readdir(modelDir);
    const stemDir = path.join(modelDir, trackDirs[0]);
    const map = [
      { key: 'lead_vocals', label: 'ร้องนำ', source: 'vocals', filter: 'pan=stereo|c0=0.5*c0+0.5*c1|c1=0.5*c0+0.5*c1' },
      { key: 'backing_vocals', label: 'แบ็กกิ้งโวคอล', source: 'vocals', filter: 'pan=stereo|c0=c0-c1|c1=c1-c0,volume=1.8' },
      { key: 'solo_guitar', label: 'กีตาร์โซโล่', source: 'guitar', filter: 'pan=stereo|c0=0.5*c0+0.5*c1|c1=0.5*c0+0.5*c1,highpass=f=180,lowpass=f=7000' },
      { key: 'chord_guitar', label: 'กีตาร์คอร์ด', source: 'guitar', filter: 'pan=stereo|c0=c0-c1|c1=c1-c0,highpass=f=80,lowpass=f=5000,volume=1.6' },
      { key: 'bass', label: 'เบส', source: 'bass' },
      { key: 'piano', label: 'คีย์บอร์ด', source: 'piano' },
      { key: 'drums', label: 'กลอง', source: 'drums' },
      { key: 'bowed_strings', label: 'เครื่องสี', source: 'other', filter: 'pan=stereo|c0=c0-0.72*c1|c1=c1-0.72*c0,highpass=f=120,lowpass=f=6500,afftdn=nf=-35,volume=1.5' },
      { key: 'brass', label: 'เครื่องเป่าทองเหลือง', source: 'other', filter: 'pan=stereo|c0=0.5*c0+0.5*c1|c1=0.5*c0+0.5*c1,highpass=f=100,lowpass=f=8000,acompressor=threshold=-22dB:ratio=3:attack=8:release=120' }
    ];
    job.status = 'encoding'; job.progress = 92; job.message = 'กำลังแปลงไฟล์สำหรับเล่นบนเว็บ';
    job.stems = [];
    for (const stem of map) {
      const wav = path.join(stemDir, `${stem.source}.wav`);
      const out = path.join(jobDir, `${stem.key}.m4a`);
      const filter = stem.filter ? ['-af', stem.filter] : [];
      await run(ffmpegPath, ['-y', '-i', wav, ...filter, '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out]);
      job.stems.push({ key: stem.key, label: stem.label, url: `/jobs/${job.id}/${stem.key}.m4a` });
    }
    job.duration = duration;
    job.status = 'done'; job.progress = 100; job.message = 'พร้อมมิกซ์';
    await fsp.writeFile(path.join(jobDir, 'job.json'), JSON.stringify(publicJob(job)));
  } catch (error) {
    job.status = 'error'; job.error = error.message.slice(-1500); job.message = 'ประมวลผลไม่สำเร็จ';
    if (source.file) fsp.rm(source.file, { force: true }).catch(() => {});
  }
}

app.post('/api/jobs/url', (req, res) => {
  if (!youtubeUrl(req.body.url)) return res.status(400).json({ error: 'รองรับเฉพาะลิงก์ YouTube แบบ HTTPS' });
  const id = crypto.randomUUID();
  const job = { id, status: 'queued', progress: 1, message: 'อยู่ในคิว', title: 'YouTube Track', stems: [] };
  jobs.set(id, job); processJob(job, { url: req.body.url });
  res.status(202).json(publicJob(job));
});

app.post('/api/jobs/file', upload.single('audio'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'กรุณาเลือกไฟล์เสียง' });
  const id = crypto.randomUUID();
  const job = { id, status: 'queued', progress: 1, message: 'อยู่ในคิว', title: safeName(req.file.originalname), stems: [] };
  jobs.set(id, job); processJob(job, { file: req.file.path, title: req.file.originalname });
  res.status(202).json(publicJob(job));
});

app.get('/api/jobs/:id', async (req, res) => {
  let job = jobs.get(req.params.id);
  if (!job) {
    try { job = JSON.parse(await fsp.readFile(path.join(OUTPUTS, req.params.id, 'job.json'), 'utf8')); }
    catch { return res.status(404).json({ error: 'ไม่พบงาน' }); }
  }
  res.json(publicJob(job));
});

app.get('/api/jobs/:id/stems.zip', async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== 'done') return res.status(409).json({ error: 'งานยังไม่เสร็จ' });
  res.attachment(`${safeName(job.title)}-stems.zip`);
  const zip = archiver('zip', { zlib: { level: 6 } });
  zip.on('error', err => res.destroy(err)); zip.pipe(res);
  for (const stem of job.stems) zip.file(path.join(OUTPUTS, job.id, `${stem.key}.m4a`), { name: `${stem.label}.m4a` });
  zip.finalize();
});

app.post('/api/jobs/:id/mix', async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== 'done') return res.status(409).json({ error: 'งานยังไม่เสร็จ' });
  const gains = req.body.gains || {};
  const semitones = Math.max(-12, Math.min(12, Math.round(Number(req.body.semitones || 0))));
  const inputs = [], filters = [];
  job.stems.forEach((stem, i) => {
    inputs.push('-i', path.join(OUTPUTS, job.id, `${stem.key}.m4a`));
    const gain = Math.max(0, Math.min(1.5, Number(gains[stem.key] ?? 1)));
    filters.push(`[${i}:a]volume=${gain}[a${i}]`);
  });
  const out = path.join(OUTPUTS, job.id, `mix-${Date.now()}.m4a`);
  try {
    const ratio = Math.pow(2, semitones / 12);
    const pitch = semitones ? `,asetrate=44100*${ratio},aresample=44100,atempo=${1 / ratio}` : '';
    await run(ffmpegPath, ['-y', ...inputs, '-filter_complex', `${filters.join(';')};${job.stems.map((_, i) => `[a${i}]`).join('')}amix=inputs=${job.stems.length}:normalize=0${pitch}[out]`, '-map', '[out]', '-c:a', 'aac', '-b:a', '256k', out]);
    res.download(out, `${safeName(job.title)}-mix.m4a`, () => fsp.rm(out, { force: true }));
  } catch (e) { res.status(500).json({ error: e.message.slice(-1000) }); }
});

app.post('/api/jobs/:id/transpose', async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== 'done') return res.status(409).json({ error: 'งานยังไม่เสร็จ' });
  const semitones = Math.max(-12, Math.min(12, Math.round(Number(req.body.semitones || 0))));
  if (!semitones) return res.json({ stems: job.stems, semitones: 0 });
  const ratio = Math.pow(2, semitones / 12), dir = path.join(OUTPUTS, job.id, `pitch-${semitones}`);
  await fsp.mkdir(dir, { recursive: true });
  try {
    const stems = [];
    for (const stem of job.stems) {
      const input = path.join(OUTPUTS, job.id, `${stem.key}.m4a`), out = path.join(dir, `${stem.key}.m4a`);
      if (!fs.existsSync(out)) await run(ffmpegPath, ['-y', '-i', input, '-af', `asetrate=44100*${ratio},aresample=44100,atempo=${1 / ratio}`, '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out]);
      stems.push({ ...stem, url: `/jobs/${job.id}/pitch-${semitones}/${stem.key}.m4a` });
    }
    res.json({ stems, semitones });
  } catch (e) { res.status(500).json({ error: e.message.slice(-1000) }); }
});

app.use((err, _req, res, _next) => res.status(400).json({ error: err.message }));
const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`Stemify ready at http://localhost:${port}`));
