const express = require('express');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// PostgreSQL Konekcija (Render / Neon / Local)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/krankenbeforderung',
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Inicijalizacija Baze i Kreiranje Tabela
async function initDb() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS trips (
        id SERIAL PRIMARY KEY,
        nr VARCHAR(20) UNIQUE NOT NULL,
        fahrzeug VARCHAR(50),
        name VARCHAR(250) NOT NULL,
        krkasse VARCHAR(100),
        datum DATE NOT NULL,
        zeit VARCHAR(10) NOT NULL,
        art VARCHAR(50),
        von TEXT NOT NULL,
        nach TEXT NOT NULL,
        grund TEXT,
        med_ger TEXT,
        komm TEXT,
        ls VARCHAR(20) DEFAULT '---',
        status VARCHAR(50) DEFAULT '1. Angenommen',
        is_archived BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        completed_at TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS trip_status_history (
        id SERIAL PRIMARY KEY,
        trip_id INT REFERENCES trips(id) ON DELETE CASCADE,
        status VARCHAR(50) NOT NULL,
        changed_by VARCHAR(100) DEFAULT 'System',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS chat_messages (
        id SERIAL PRIMARY KEY,
        fahrzeug VARCHAR(50) NOT NULL,
        sender VARCHAR(50) NOT NULL,
        text TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✅ Baza podataka je uspešno inicijalizovana.');
  } catch (err) {
    console.error('❌ Greška pri inicijalizaciji baze:', err);
  } finally {
    client.release();
  }
}

initDb();

// ------------------- API RUTE: NALOZI (TRIPS) -------------------

// 1. Dobijanje aktivnih naloga (Nisu arhivirani / status nije 5. Erledigt)
app.get('/api/trips', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM trips 
      WHERE is_archived = FALSE 
      ORDER BY id DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Kreiranje novog naloga
app.post('/api/trips', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { fahrzeug, name, krkasse, datum, zeit, art, von, nach, grund, med_ger, komm, ls } = req.body;
    const nr = Math.floor(10000 + Math.random() * 90000).toString();

    const insertTripQuery = `
      INSERT INTO trips (nr, fahrzeug, name, krkasse, datum, zeit, art, von, nach, grund, med_ger, komm, ls, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, '1. Angenommen')
      RETURNING *;
    `;
    const tripRes = await client.query(insertTripQuery, [nr, fahrzeug, name, krkasse, datum, zeit, art, von, nach, grund, med_ger, komm, ls]);
    const newTrip = tripRes.rows[0];

    // Upis u istoriju statusa
    await client.query(`
      INSERT INTO trip_status_history (trip_id, status, changed_by)
      VALUES ($1, $2, $3);
    `, [newTrip.id, '1. Angenommen', 'Disponent']);

    await client.query('COMMIT');
    res.status(201).json(newTrip);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// 3. Ažuriranje statusa naloga (i automatsko arhiviranje po završetku)
app.put('/api/trips/:id/status', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { id } = req.params;
    const { status, changed_by } = req.body;

    const isErledigt = status === '5. Erledigt';
    const updateTripQuery = `
      UPDATE trips 
      SET status = $1, 
          is_archived = CASE WHEN $1 = '5. Erledigt' THEN TRUE ELSE is_archived END,
          completed_at = CASE WHEN $1 = '5. Erledigt' THEN CURRENT_TIMESTAMP ELSE completed_at END
      WHERE id = $2
      RETURNING *;
    `;
    const tripRes = await client.query(updateTripQuery, [status, id]);

    if (tripRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Nalog nije pronađen' });
    }

    // Upis u istoriju
    await client.query(`
      INSERT INTO trip_status_history (trip_id, status, changed_by)
      VALUES ($1, $2, $3);
    `, [id, status, changed_by || 'Vozac']);

    await client.query('COMMIT');
    res.json(tripRes.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ------------------- API RUTE: ARHIVA, PRETRAGA I PAGINACIJA -------------------

app.get('/api/archive', async (req, res) => {
  try {
    const { search, driver, date_from, date_to, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    let whereClauses = ['is_archived = TRUE'];
    let queryParams = [];
    let paramIdx = 1;

    if (search) {
      whereClauses.push(`(name ILIKE $${paramIdx} OR nr ILIKE $${paramIdx} OR von ILIKE $${paramIdx} OR nach ILIKE $${paramIdx})`);
      queryParams.push(`%${search}%`);
      paramIdx++;
    }

    if (driver) {
      whereClauses.push(`fahrzeug = $${paramIdx}`);
      queryParams.push(driver);
      paramIdx++;
    }

    if (date_from) {
      whereClauses.push(`datum >= $${paramIdx}`);
      queryParams.push(date_from);
      paramIdx++;
    }

    if (date_to) {
      whereClauses.push(`datum <= $${paramIdx}`);
      queryParams.push(date_to);
      paramIdx++;
    }

    const whereSql = whereClauses.join(' AND ');

    // Prebrojavanje za paginaciju
    const countQuery = `SELECT COUNT(*) FROM trips WHERE ${whereSql}`;
    const countRes = await pool.query(countQuery, queryParams);
    const totalItems = parseInt(countRes.rows[0].count);

    // Glavni upit
    const dataQuery = `
      SELECT * FROM trips 
      WHERE ${whereSql} 
      ORDER BY completed_at DESC 
      LIMIT $${paramIdx} OFFSET $${paramIdx + 1}
    `;
    queryParams.push(limit, offset);

    const dataRes = await pool.query(dataQuery, queryParams);

    res.json({
      data: dataRes.rows,
      pagination: {
        totalItems,
        totalPages: Math.ceil(totalItems / limit),
        currentPage: parseInt(page),
        limit: parseInt(limit)
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Detalji arhiviranog naloga sa istorijom statusa
app.get('/api/archive/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const tripRes = await pool.query('SELECT * FROM trips WHERE id = $1', [id]);
    
    if (tripRes.rows.length === 0) {
      return res.status(404).json({ error: 'Nalog nije pronađen' });
    }

    const historyRes = await pool.query(
      'SELECT * FROM trip_status_history WHERE trip_id = $1 ORDER BY created_at ASC',
      [id]
    );

    res.json({
      trip: tripRes.rows[0],
      history: historyRes.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ------------------- API RUTE: CHAT -------------------

app.get('/api/chat', async (req, res) => {
  try {
    const { fahrzeug } = req.query;
    if (!fahrzeug) return res.json([]);
    
    const result = await pool.query(
      'SELECT * FROM chat_messages WHERE fahrzeug = $1 ORDER BY id ASC',
      [fahrzeug]
    );
    
    const formatted = result.rows.map(m => ({
      ...m,
      time: new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    }));

    res.json(formatted);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/chat', async (req, res) => {
  try {
    const { fahrzeug, sender, text } = req.body;
    const result = await pool.query(
      'INSERT INTO chat_messages (fahrzeug, sender, text) VALUES ($1, $2, $3) RETURNING *',
      [fahrzeug, sender, text]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server radi na http://localhost:${PORT}`);
});