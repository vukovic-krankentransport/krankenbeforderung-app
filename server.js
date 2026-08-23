const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function initDb() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS trips (
        id SERIAL PRIMARY KEY,
        nr VARCHAR(50),
        datum VARCHAR(50),
        zeit VARCHAR(50),
        name VARCHAR(100),
        krkasse VARCHAR(100),
        art VARCHAR(50),
        ls VARCHAR(50),
        von TEXT,
        nach TEXT,
        grund TEXT,
        med_ger TEXT,
        komm TEXT,
        fahrzeug VARCHAR(50),
        status VARCHAR(50) DEFAULT '1. Angenommen',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS chat_messages (
        id SERIAL PRIMARY KEY,
        fahrzeug VARCHAR(50),
        sender VARCHAR(50),
        text TEXT,
        time VARCHAR(50),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log("PostgreSQL tabele spremne.");
  } catch (err) {
    console.error("Greška sa bazom:", err);
  }
}
initDb();

// VOŽNJE
app.get('/api/trips', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM trips ORDER BY id DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/trips', async (req, res) => {
  const { nr, datum, zeit, name, krkasse, art, ls, von, nach, grund, med_ger, komm, fahrzeug, status } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO trips (nr, datum, zeit, name, krkasse, art, ls, von, nach, grund, med_ger, komm, fahrzeug, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
      [nr, datum, zeit, name, krkasse, art, ls, von, nach, grund, med_ger, komm, fahrzeug, status || '1. Angenommen']
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/trips/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  try {
    const result = await pool.query(
      'UPDATE trips SET status = $1 WHERE id = $2 RETURNING *',
      [status, id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// CHAT
app.get('/api/chat', async (req, res) => {
  const { fahrzeug } = req.query;
  try {
    let result;
    if (fahrzeug) {
      result = await pool.query('SELECT * FROM chat_messages WHERE fahrzeug = $1 ORDER BY id ASC', [fahrzeug]);
    } else {
      result = await pool.query('SELECT * FROM chat_messages ORDER BY id ASC');
    }
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/chat', async (req, res) => {
  const { fahrzeug, sender, text, time } = req.body;
  const msgTime = time || new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  try {
    const result = await pool.query(
      'INSERT INTO chat_messages (fahrzeug, sender, text, time) VALUES ($1, $2, $3, $4) RETURNING *',
      [fahrzeug, sender, text, msgTime]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(port, () => {
  console.log(`Server pokrenut na portu ${port}`);
});
