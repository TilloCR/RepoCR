const express = require('express');
const multer = require('multer');
const path = require('path');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const session = require('express-session');
const bcrypt = require('bcryptjs');

const app = express();
const PORT = 3000;

const db = new Database('petqrapp.db');
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS pets (
    id TEXT PRIMARY KEY,
    pet_name TEXT,
    pet_type TEXT,
    pet_breed TEXT,
    pet_age TEXT,
    owner_name TEXT,
    owner_phone TEXT,
    owner_email TEXT,
    owner_alt_phone TEXT,
    photo TEXT,
    password TEXT,
    registered INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

const storage = multer.diskStorage({
  destination: 'public/uploads/',
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, uuidv4() + ext);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp/;
    const ext = allowed.test(path.extname(file.originalname).toLowerCase());
    const mime = allowed.test(file.mimetype);
    if (ext && mime) return cb(null, true);
    cb(new Error('Solo imágenes (jpg, png, gif, webp)'));
  }
});

app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));

app.use(session({
  secret: 'petqr-secret-key-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

app.use((req, res, next) => {
  res.locals.session = req.session;
  next();
});

app.get('/', (req, res) => {
  const petId = req.query.id;
  if (petId) {
    const pet = db.prepare('SELECT * FROM pets WHERE id = ?').get(petId);
    if (pet && pet.registered) {
      const isOwner = req.session.petId === petId;
      const loginError = req.query.error || null;
      return res.render('profile', { pet, isOwner, loginError });
    }
    return res.redirect('/register?id=' + petId);
  }
  res.redirect('/dashboard');
});

app.get('/register', (req, res) => {
  const petId = req.query.id;
  if (!petId) {
    return res.redirect('/dashboard');
  }
  res.render('register', { petId, error: null });
});

app.post('/register', upload.single('photo'), async (req, res) => {
  const { pet_id, pet_name, pet_type, pet_breed, pet_age, owner_name, owner_phone, owner_email, owner_alt_phone, password } = req.body;

  if (!pet_id || !pet_name || !pet_type || !owner_name || !owner_phone) {
    return res.render('register', { petId: pet_id, error: 'Nombre de mascota, tipo, dueño y teléfono son obligatorios' });
  }

  const photo = req.file ? '/uploads/' + req.file.filename : null;
  const passwordHash = password ? await bcrypt.hash(password, 10) : null;

  db.prepare(`
    INSERT INTO pets (id, pet_name, pet_type, pet_breed, pet_age, owner_name, owner_phone, owner_email, owner_alt_phone, photo, password, registered)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(id) DO UPDATE SET
      pet_name = excluded.pet_name, pet_type = excluded.pet_type,
      pet_breed = excluded.pet_breed, pet_age = excluded.pet_age,
      owner_name = excluded.owner_name, owner_phone = excluded.owner_phone,
      owner_email = excluded.owner_email, owner_alt_phone = excluded.owner_alt_phone,
      photo = COALESCE(excluded.photo, photo),
      password = COALESCE(excluded.password, password),
      registered = 1
  `).run(pet_id, pet_name, pet_type, pet_breed, pet_age, owner_name, owner_phone, owner_email, owner_alt_phone, photo, passwordHash);

  req.session.petId = pet_id;
  res.redirect('/?id=' + pet_id);
});

app.post('/login', async (req, res) => {
  const { pet_id, password } = req.body;
  const pet = db.prepare('SELECT * FROM pets WHERE id = ?').get(pet_id);

  if (!pet || !pet.password) {
    return res.redirect('/?id=' + pet_id + '&error=credenciales+incorrectas');
  }

  const match = await bcrypt.compare(password, pet.password);
  if (!match) {
    return res.redirect('/?id=' + pet_id + '&error=credenciales+incorrectas');
  }

  req.session.petId = pet_id;
  res.redirect('/?id=' + pet_id);
});

app.get('/logout', (req, res) => {
  const petId = req.query.id;
  req.session.destroy();
  res.redirect('/?id=' + petId);
});

app.get('/edit', (req, res) => {
  const petId = req.query.id;
  if (!petId || req.session.petId !== petId) {
    return res.redirect('/?id=' + petId);
  }
  const pet = db.prepare('SELECT * FROM pets WHERE id = ?').get(petId);
  if (!pet) return res.redirect('/dashboard');
  res.render('edit', { pet, error: null });
});

app.post('/edit', upload.single('photo'), async (req, res) => {
  const { pet_id, pet_name, pet_type, pet_breed, pet_age, owner_name, owner_phone, owner_email, owner_alt_phone, password } = req.body;

  if (req.session.petId !== pet_id) {
    return res.redirect('/?id=' + pet_id);
  }

  const photo = req.file ? '/uploads/' + req.file.filename : null;

  let sql = `UPDATE pets SET pet_name=?, pet_type=?, pet_breed=?, pet_age=?, owner_name=?, owner_phone=?, owner_email=?, owner_alt_phone=?`;
  const params = [pet_name, pet_type, pet_breed, pet_age, owner_name, owner_phone, owner_email, owner_alt_phone];

  if (photo) {
    sql += `, photo=?`;
    params.push(photo);
  }
  if (password && password.length > 0) {
    const hash = await bcrypt.hash(password, 10);
    sql += `, password=?`;
    params.push(hash);
  }
  sql += ` WHERE id=?`;
  params.push(pet_id);

  db.prepare(sql).run(...params);
  res.redirect('/?id=' + pet_id);
});

app.get('/dashboard', (req, res) => {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const plates = db.prepare('SELECT * FROM pets ORDER BY created_at DESC').all();
  const stats = db.prepare(`
    SELECT COUNT(*) as total, SUM(registered) as registered, SUM(CASE WHEN registered = 0 THEN 1 ELSE 0 END) as pending
    FROM pets
  `).get();
  res.render('dashboard', { baseUrl, plates, stats });
});

app.post('/dashboard/generate', (req, res) => {
  const { prefix, count } = req.body;
  const num = parseInt(count) || 1;
  const stmt = db.prepare('INSERT OR IGNORE INTO pets (id, registered) VALUES (?, 0)');
  for (let i = 1; i <= num; i++) {
    stmt.run((prefix + i).toUpperCase());
  }
  res.redirect('/dashboard');
});

app.post('/dashboard/delete', (req, res) => {
  const { id } = req.body;
  db.prepare('DELETE FROM pets WHERE id = ?').run(id);
  res.redirect('/dashboard');
});

app.get('/qr/:id', (req, res) => {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const url = `${baseUrl}/?id=${req.params.id}`;
  res.render('qr', { id: req.params.id, url });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`PetQR App corriendo en http://localhost:${PORT}`);
});
