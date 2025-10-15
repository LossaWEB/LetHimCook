// server.js — LetHimCook

const express = require('express');
const path = require('path');
const fs = require('fs');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const methodOverride = require('method-override');
const expressLayouts = require('express-ejs-layouts');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

/* ───────────────── Middlewares / Views ───────────────── */
app.use(express.urlencoded({ extended: true }));
app.use(methodOverride('_method'));
app.use('/public', express.static(path.join(__dirname, 'public')));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'layouts/layout');

app.use(
  session({
    secret: 'change-this-secret',
    resave: false,
    saveUninitialized: false,
  })
);

// Flash (facultatif)
app.use((req, res, next) => {
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  res.locals.user = req.session.user || null;
  next();
});
function flash(req, type, message) {
  req.session.flash = { type, message };
}

/* ───────────────── DB bootstrap ───────────────── */
async function ensureSchema() {
  // users
  if (!(await db.schema.hasTable('users'))) {
    await db.schema.createTable('users', (t) => {
      t.increments('id').primary();
      t.string('email').unique().notNullable();
      t.string('password_hash').notNullable();
      t.string('display_name').notNullable();
      t.text('allergens'); // CSV
      t.timestamps(true, true);
    });
  } else {
    const hasAllergens = await db.schema.hasColumn('users', 'allergens');
    if (!hasAllergens) await db.schema.table('users', (t) => t.text('allergens'));
  }

  // recipes
  if (!(await db.schema.hasTable('recipes'))) {
    await db.schema.createTable('recipes', (t) => {
      t.increments('id').primary();
      t.integer('user_id').references('id').inTable('users').onDelete('SET NULL');
      t.string('title').notNullable();
      t.string('category').notNullable();
      t.string('difficulty').notNullable();
      t.integer('duration_minutes').notNullable();
      t.string('image_path');
      t.text('ingredients').notNullable();
      t.text('steps').notNullable();
      t.integer('time_active');
      t.integer('time_rest');
      t.integer('time_total');
      t.text('tips');
      t.integer('kcal');
      t.integer('protein');
      t.integer('fat');
      t.integer('carb');
      t.timestamp('deleted_at').nullable();
      t.timestamps(true, true);
    });
  } else {
    const addCol = async (name, cb) => {
      const has = await db.schema.hasColumn('recipes', name);
      if (!has) await db.schema.table('recipes', cb);
    };
    await addCol('time_active', (t) => t.integer('time_active'));
    await addCol('time_rest', (t) => t.integer('time_rest'));
    await addCol('time_total', (t) => t.integer('time_total'));
    await addCol('tips', (t) => t.text('tips'));
    await addCol('kcal', (t) => t.integer('kcal'));
    await addCol('protein', (t) => t.integer('protein'));
    await addCol('fat', (t) => t.integer('fat'));
    await addCol('carb', (t) => t.integer('carb'));
    await addCol('deleted_at', (t) => t.timestamp('deleted_at').nullable());
  }

  // comments
  if (!(await db.schema.hasTable('comments'))) {
    await db.schema.createTable('comments', (t) => {
      t.increments('id').primary();
      t.integer('recipe_id').references('id').inTable('recipes').onDelete('CASCADE').notNullable();
      t.integer('user_id').references('id').inTable('users').onDelete('SET NULL');
      t.integer('parent_id').references('id').inTable('comments').onDelete('CASCADE').nullable();
      t.text('body').notNullable();
      t.timestamps(true, true);
    });
  } else {
    const hasParent = await db.schema.hasColumn('comments', 'parent_id');
    if (!hasParent) {
      await db.schema.table('comments', (t) =>
        t.integer('parent_id').references('id').inTable('comments').onDelete('CASCADE').nullable()
      );
    }
  }

  // ratings
  if (!(await db.schema.hasTable('ratings'))) {
    await db.schema.createTable('ratings', (t) => {
      t.increments('id').primary();
      t.integer('recipe_id').references('id').inTable('recipes').onDelete('CASCADE').notNullable();
      t.integer('user_id').references('id').inTable('users').onDelete('CASCADE').notNullable();
      t.integer('value').notNullable(); // 1..5
      t.timestamps(true, true);
      t.unique(['recipe_id', 'user_id']);
    });
  }

  // favorites
  if (!(await db.schema.hasTable('favorites'))) {
    await db.schema.createTable('favorites', (t) => {
      t.increments('id').primary();
      t.integer('recipe_id').references('id').inTable('recipes').onDelete('CASCADE').notNullable();
      t.integer('user_id').references('id').inTable('users').onDelete('CASCADE').notNullable();
      t.timestamps(true, true);
      t.unique(['recipe_id', 'user_id']);
    });
  }

  // tags & pivot
  if (!(await db.schema.hasTable('tags'))) {
    await db.schema.createTable('tags', (t) => {
      t.increments('id').primary();
      t.string('name').unique().notNullable();
    });
  }
  if (!(await db.schema.hasTable('recipe_tags'))) {
    await db.schema.createTable('recipe_tags', (t) => {
      t.increments('id').primary();
      t.integer('recipe_id').references('id').inTable('recipes').onDelete('CASCADE').notNullable();
      t.integer('tag_id').references('id').inTable('tags').onDelete('CASCADE').notNullable();
      t.unique(['recipe_id', 'tag_id']);
    });
  }
}
ensureSchema();

/* ───────────────── Utils ───────────────── */
function placeholderURL(category) {
  const label = category === 'Dessert' ? 'Dessert' : category === 'Entrée' ? 'Entrée' : 'Plat';
  const svg = encodeURIComponent(`
    <svg xmlns='http://www.w3.org/2000/svg' width='1200' height='800'>
      <defs><linearGradient id='g' x1='0' x2='1' y1='0' y2='1'>
        <stop offset='0%' stop-color='#eef2ff'/><stop offset='100%' stop-color='#e2e8f0'/>
      </linearGradient></defs>
      <rect width='100%' height='100%' fill='url(#g)'/>
      <text x='50%' y='42%' text-anchor='middle' font-family='Inter, Arial' font-size='56' fill='#0f172a' font-weight='800'>LetHimCook</text>
      <text x='50%' y='57%' text-anchor='middle' font-family='Inter, Arial' font-size='26' fill='#334155'>${label} • Photo recette</text>
    </svg>
  `);
  return `data:image/svg+xml,${svg}`;
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, 'public', 'uploads')),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, unique + ext);
  },
});
function fileFilter(req, file, cb) {
  if (!file.mimetype.startsWith('image/')) return cb(new Error('Seules les images sont autorisées.'), false);
  cb(null, true);
}
const upload = multer({ storage, limits: { fileSize: 2 * 1024 * 1024 }, fileFilter });

function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/login'); 
  next();
}
function now() { return db.fn.now(); }
function sanitizeTags(input) {
  return (input || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0)
    .slice(0, 12);
}
async function upsertTagsAndLink(recipeId, tagsArr) {
  const ids = [];
  for (const name of tagsArr) {
    let tag = await db('tags').where({ name }).first();
    if (!tag) {
      const [id] = await db('tags').insert({ name });
      ids.push(id);
    } else ids.push(tag.id);
  }
  await db('recipe_tags').where({ recipe_id: recipeId }).del();
  for (const tagId of ids) {
    await db('recipe_tags').insert({ recipe_id: recipeId, tag_id: tagId });
  }
}
function parseAdvancedQuery(qs) {
  const q = (qs || '').trim();
  const res = { text: [], max: null, diff: null, ing: [], sans: [] };
  q.split(/\s+/).forEach((tok) => {
    if (tok.startsWith('max:')) res.max = parseInt(tok.slice(4), 10) || null;
    else if (tok.startsWith('diff:')) res.diff = tok.slice(5);
    else if (tok.startsWith('ing:')) res.ing.push(tok.slice(4).toLowerCase());
    else if (tok.startsWith('sans:')) res.sans.push(tok.slice(5).toLowerCase());
    else res.text.push(tok);
  });
  return res;
}

function popularityOrder(qb) {
  return qb.orderBy('recipes.created_at', 'desc');
}

async function getRecommendations(recipeId, recipe) {
  return await db('recipes')
    .whereNull('deleted_at')
    .andWhereNot('id', recipeId)
    .andWhere((b) => b.where({ category: recipe.category }).orWhere({ difficulty: recipe.difficulty }))
    .select('recipes.*')
    .orderBy('recipes.created_at', 'desc')
    .limit(6);
}

/* ───────────────── Badges (simple) ───────────────── */
async function computeBadges(userId) {
  const [{ c: myCountRaw }] = await db('recipes').where({ user_id: userId, deleted_at: null }).count({ c: '*' });
  const myCount = Number(myCountRaw) || 0;
  const [{ fastRaw }] = await db('recipes').where({ user_id: userId, deleted_at: null }).andWhere('duration_minutes', '<', 20).count({ fastRaw: '*' });
  const fastCount = Number(fastRaw) || 0;
  const [{ favsRaw }] = await db('favorites').where({ user_id: userId }).count({ favsRaw: '*' });
  const favs = Number(favsRaw) || 0;

  const badges = [];
  if (myCount >= 1) badges.push('Première recette');
  if (fastCount >= 3) badges.push('Chef Express (≥3 recettes < 20 min)');
  if (favs >= 5) badges.push('Fan de saveurs (≥5 favoris)');
  return badges;
}

/* ───────────────── Routes ───────────────── */

// Accueil
app.get('/', async (req, res) => {
  const h = (req.query.h || 'latest').toLowerCase();
  let base = db('recipes').whereNull('deleted_at');
  if (h === 'fast') base = base.orderBy('duration_minutes', 'asc');
  else if (h === 'easy') base = base.where({ difficulty: 'Facile' }).orderBy('created_at', 'desc');
  else base = base.orderBy('created_at', 'desc');
  const latest = await base.limit(6);
  res.render('home', { user: req.session.user, latest, h, pageTitle: 'Accueil' });
});

// Auth
app.get('/register', (req, res) => res.render('auth/register', { user: req.session.user, error: null, pageTitle: 'Créer un compte' }));
app.post('/register', async (req, res) => {
  const { email, password, display_name, allergens } = req.body;
  if (!email || !password || !display_name) return res.render('auth/register', { user: null, error: 'Tous les champs sont requis.', pageTitle: 'Créer un compte' });
  const exists = await db('users').where({ email }).first();
  if (exists) return res.render('auth/register', { user: null, error: 'Email déjà utilisé.', pageTitle: 'Créer un compte' });
  const hash = await bcrypt.hash(password, 10);
  const [id] = await db('users').insert({ email, password_hash: hash, display_name, allergens: (allergens || '').toLowerCase() });
  req.session.user = { id, email, display_name, allergens: (allergens || '').toLowerCase() };
  flash(req, 'success', 'Compte créé. Bienvenue !');
  res.redirect('/');
});

app.get('/login', (req, res) => res.render('auth/login', { user: req.session.user, error: null, pageTitle: 'Connexion' }));
app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await db('users').where({ email }).first();
  if (!user) return res.render('auth/login', { user: null, error: 'Identifiants invalides.', pageTitle: 'Connexion' });
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.render('auth/login', { user: null, error: 'Identifiants invalides.', pageTitle: 'Connexion' });
  req.session.user = { id: user.id, email: user.email, display_name: user.display_name, allergens: user.allergens || '' };
  flash(req, 'success', 'Connexion réussie.');
  res.redirect('/');
});
app.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/')));

// Profil
app.get('/me', requireAuth, async (req, res) => {
  const mine = await db('recipes').where({ user_id: req.session.user.id }).whereNull('deleted_at').orderBy('created_at', 'desc');
  const favs = await db('favorites')
    .join('recipes', 'favorites.recipe_id', 'recipes.id')
    .where('favorites.user_id', req.session.user.id)
    .whereNull('recipes.deleted_at')
    .select('recipes.*')
    .orderBy('favorites.created_at', 'desc');
  const badges = await computeBadges(req.session.user.id);
  res.render('profile/show', { user: req.session.user, mine, favs, badges, pageTitle: 'Profil' });
});

// Liste / recherche
app.get('/recipes', async (req, res) => {
  const { q, category, difficulty, tag, page = 1, sort = 'created_at', order = 'desc' } = req.query;

  const currentPage = Math.max(1, parseInt(page, 10) || 1);
  const perPage = 9;

  let base = db('recipes').whereNull('deleted_at');

  if (category && category !== 'all') base = base.where({ category });
  if (difficulty && difficulty !== 'all') base = base.where({ difficulty });

  if (tag && tag !== 'all') {
    base = base
      .join('recipe_tags as rt', 'recipes.id', 'rt.recipe_id')
      .join('tags as t', 'rt.tag_id', 't.id')
      .where('t.name', tag);
  }

  const parsed = parseAdvancedQuery(q);
  if (parsed.text.length) base = base.where('title', 'like', `%${parsed.text.join(' ')}%`);
  if (parsed.max) base = base.where('duration_minutes', '<=', parsed.max);
  if (parsed.diff) base = base.where('difficulty', 'like', `%${parsed.diff}%`);
  if (parsed.ing.length) parsed.ing.forEach((kw) => { base = base.where('ingredients', 'like', `%${kw}%`); });
  if (parsed.sans.length) parsed.sans.forEach((kw) => { base = base.whereNot('ingredients', 'like', `%${kw}%`); });

  let listQuery = base.clone().select('recipes.*');
  const allowed = ['created_at', 'title', 'duration_minutes'];
  const col = allowed.includes(sort) ? sort : 'created_at';
  const dir = (order || '').toLowerCase() === 'asc' ? 'asc' : 'desc';
  listQuery = listQuery.orderBy(col, dir);

  const [{ c: totalRaw }] = await base.clone().count({ c: '*' });
  const total = Number(totalRaw) || 0;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const clampPage = Math.min(currentPage, totalPages);

  const recipes = await listQuery.limit(perPage).offset((clampPage - 1) * perPage);
  const allTags = await db('tags').select('name').orderBy('name');

  res.render('recipes/index', {
    user: req.session.user,
    recipes,
    q: q || '',
    category: category || 'all',
    difficulty: difficulty || 'all',
    tag: tag || 'all',
    sort: col, order: dir,
    page: clampPage, totalPages,
    allTags,
    pageTitle: 'Toutes les recettes',
  });
});

// Nouvelle recette
app.get('/recipes/new', requireAuth, (req, res) => {
  res.render('recipes/new', { user: req.session.user, error: null, pageTitle: 'Nouvelle recette' });
});

// Création recette
app.post('/recipes', requireAuth, upload.single('image'), async (req, res) => {
  try {
    const {
      title, category, difficulty, duration_minutes,
      ingredients, steps, tips,
      time_active, time_rest, kcal, protein, fat, carb,
      tags
    } = req.body;

    const image_path = req.file ? '/public/uploads/' + req.file.filename : placeholderURL(category);

    const timeActive = parseInt(time_active || '0', 10) || 0;
    const timeRest = parseInt(time_rest || '0', 10) || 0;
    const total = (parseInt(duration_minutes || '0', 10) || 0) || (timeActive + timeRest);

    const [recipeId] = await db('recipes').insert({
      user_id: req.session.user.id,
      title, category, difficulty,
      duration_minutes: total || 1,
      time_active: timeActive, time_rest: timeRest, time_total: total || 1,
      image_path, ingredients, steps, tips: tips || '',
      kcal: parseInt(kcal || '0', 10) || null,
      protein: parseInt(protein || '0', 10) || null,
      fat: parseInt(fat || '0', 10) || null,
      carb: parseInt(carb || '0', 10) || null,
      created_at: now(), updated_at: now(),
    });

    await upsertTagsAndLink(recipeId, sanitizeTags(tags));

    flash(req, 'success', 'Recette créée ✅');
    res.redirect('/recipes/' + recipeId);
  } catch (err) {
    console.error(err);
    res.status(500).render('500', { user: req.session.user, pageTitle: 'Erreur' });
  }
});

// Création rapide
app.get('/recipes/quick-new', requireAuth, (req, res) => {
  res.render('recipes/quick_new', { user: req.session.user, pageTitle: 'Recette rapide' });
});
app.post('/recipes/quick-new', requireAuth, async (req, res) => {
  const { title, ingredients, steps } = req.body;
  if (!title) { flash(req, 'error', 'Titre requis'); return res.redirect('/recipes/quick-new'); }
  const [id] = await db('recipes').insert({
    user_id: req.session.user.id, title, category: 'Plat', difficulty: 'Facile',
    duration_minutes: 15, image_path: placeholderURL('Plat'),
    ingredients: ingredients || '- ', steps: steps || '1) ', created_at: now(), updated_at: now()
  });
  flash(req, 'success', 'Brouillon créé. Vous pouvez le compléter.');
  res.redirect('/recipes/' + id + '/edit');
});

// Fiche recette
app.get('/recipes/:id', async (req, res) => {
  const recipe = await db('recipes').where({ id: req.params.id }).whereNull('deleted_at').first();
  if (!recipe) return res.status(404).render('404', { user: req.session.user });

  const [{ avg: avgRaw, count: countRaw }] = await db('ratings').where({ recipe_id: recipe.id }).avg({ avg: 'value' }).count({ count: '*' });
  const avgRating = avgRaw ? Math.round(Number(avgRaw) * 10) / 10 : null;
  const ratingsCount = Number(countRaw) || 0;

  let myRating = null, isFavorited = false;
  if (req.session.user) {
    const r = await db('ratings').where({ recipe_id: recipe.id, user_id: req.session.user.id }).first();
    myRating = r ? r.value : null;
    const fav = await db('favorites').where({ recipe_id: recipe.id, user_id: req.session.user.id }).first();
    isFavorited = !!fav;
  }
  const [{ favs: favCountRaw }] = await db('favorites').where({ recipe_id: recipe.id }).count({ favs: '*' });
  const favoritesCount = Number(favCountRaw) || 0;

  const raw = await db('comments')
    .leftJoin('users', 'comments.user_id', 'users.id')
    .where('comments.recipe_id', recipe.id)
    .select('comments.*', 'users.display_name')
    .orderBy('comments.created_at', 'desc');

  const comments = raw.filter(c => !c.parent_id);
  comments.forEach(c => { c.replies = raw.filter(r => r.parent_id === c.id); });

  const recs = await getRecommendations(recipe.id, recipe);

  res.render('recipes/show', {
    user: req.session.user,
    recipe,
    avgRating, ratingsCount, myRating,
    isFavorited, favoritesCount,
    comments, recs,
    pageTitle: recipe.title
  });
});

// Noter
app.post('/recipes/:id/rate', requireAuth, async (req, res) => {
  const value = Math.max(1, Math.min(5, parseInt(req.body.value, 10) || 0));
  const recipe = await db('recipes').where({ id: req.params.id, deleted_at: null }).first();
  if (!recipe) return res.status(404).render('404', { user: req.session.user });
  const existing = await db('ratings').where({ recipe_id: recipe.id, user_id: req.session.user.id }).first();
  if (existing) {
    await db('ratings').where({ id: existing.id }).update({ value, updated_at: now() });
    flash(req, 'success', 'Note mise à jour ⭐');
  } else {
    await db('ratings').insert({ recipe_id: recipe.id, user_id: req.session.user.id, value });
    flash(req, 'success', 'Merci pour votre note ⭐');
  }
  res.redirect('/recipes/' + recipe.id + '#rating');
});

// Favori
app.post('/recipes/:id/favorite', requireAuth, async (req, res) => {
  const recipe = await db('recipes').where({ id: req.params.id, deleted_at: null }).first();
  if (!recipe) return res.status(404).render('404', { user: req.session.user });
  const existing = await db('favorites').where({ recipe_id: recipe.id, user_id: req.session.user.id }).first();
  if (existing) {
    await db('favorites').where({ id: existing.id }).del();
    flash(req, 'success', 'Retirée des favoris ❤️‍🔥');
  } else {
    await db('favorites').insert({ recipe_id: recipe.id, user_id: req.session.user.id });
    flash(req, 'success', 'Ajoutée aux favoris ❤️');
  }
  res.redirect('/recipes/' + recipe.id + '#actions');
});

// Commenter
app.post('/recipes/:id/comments', requireAuth, async (req, res) => {
  const body = (req.body.body || '').trim();
  const parent_id = req.body.parent_id ? parseInt(req.body.parent_id, 10) : null;
  const recipe = await db('recipes').where({ id: req.params.id, deleted_at: null }).first();
  if (!recipe) return res.status(404).render('404', { user: req.session.user });
  if (!body) { flash(req, 'error', 'Votre commentaire est vide.'); return res.redirect('/recipes/' + recipe.id + '#comments'); }
  await db('comments').insert({ recipe_id: recipe.id, user_id: req.session.user.id, body, parent_id });
  flash(req, 'success', 'Commentaire publié 🗨️');
  res.redirect('/recipes/' + recipe.id + '#comments');
});

// Supprimer un commentaire (si c'est le mien) 
app.post('/comments/:id/delete', requireAuth, async (req, res) => {
  const com = await db('comments').where({ id: req.params.id }).first();
  if (!com) return res.status(404).render('404', { user: req.session.user });
  if (com.user_id !== req.session.user.id) return res.redirect('/recipes/' + com.recipe_id + '#comments');
  await db('comments').where({ id: com.id }).del();
  flash(req, 'success', 'Commentaire supprimé 🗑️');
  res.redirect('/recipes/' + com.recipe_id + '#comments');
});

// Edit (seulement si propriétaire) → redirection si pas autorisé
app.get('/recipes/:id/edit', requireAuth, async (req, res) => {
  const recipe = await db('recipes').where({ id: req.params.id, deleted_at: null }).first();
  if (!recipe) return res.status(404).render('404', { user: req.session.user });
  if (recipe.user_id !== req.session.user.id) return res.redirect('/');

  const tagRows = await db('recipe_tags').where({ recipe_id: recipe.id }).join('tags', 'recipe_tags.tag_id', 'tags.id').select('tags.name');
  const tags = tagRows.map(t => t.name).join(', ');

  res.render('recipes/edit', { user: req.session.user, recipe, tags, error: null, pageTitle: 'Modifier ' + recipe.title });
});

// Update (seulement si propriétaire) → redirection si pas autorisé
app.post('/recipes/:id', requireAuth, upload.single('image'), async (req, res) => {
  const recipe = await db('recipes').where({ id: req.params.id, deleted_at: null }).first();
  if (!recipe) return res.status(404).render('404', { user: req.session.user });
  if (recipe.user_id !== req.session.user.id) return res.redirect('/');

  const {
    title, category, difficulty, duration_minutes,
    ingredients, steps, tips,
    time_active, time_rest, kcal, protein, fat, carb,
    tags
  } = req.body;

  const patch = {
    title, category, difficulty,
    ingredients, steps, tips: tips || '',
    time_active: parseInt(time_active || '0', 10) || 0,
    time_rest: parseInt(time_rest || '0', 10) || 0,
    kcal: parseInt(kcal || '0', 10) || null,
    protein: parseInt(protein || '0', 10) || null,
    fat: parseInt(fat || '0', 10) || null,
    carb: parseInt(carb || '0', 10) || null,
    updated_at: now(),
  };
  const dm = parseInt(duration_minutes || '0', 10) || (patch.time_active + patch.time_rest) || recipe.duration_minutes;
  patch.duration_minutes = dm;
  patch.time_total = dm;

  if (req.file) patch.image_path = '/public/uploads/' + req.file.filename;

  await db('recipes').where({ id: recipe.id }).update(patch);
  await upsertTagsAndLink(recipe.id, sanitizeTags(tags));

  flash(req, 'success', 'Recette enregistrée ✅');
  res.redirect('/recipes/' + recipe.id);
});

// Soft delete (seulement si propriétaire) → redirection si pas autorisé
app.delete('/recipes/:id', requireAuth, async (req, res) => {
  const recipe = await db('recipes').where({ id: req.params.id, deleted_at: null }).first();
  if (!recipe) return res.status(404).render('404', { user: req.session.user });
  if (recipe.user_id !== req.session.user.id) return res.redirect('/');
  await db('recipes').where({ id: recipe.id }).update({ deleted_at: now() });
  flash(req, 'success', 'Recette envoyée dans la corbeille 🧺');
  res.redirect('/recipes');
});

// Corbeille & opérations
app.get('/trash', requireAuth, async (req, res) => {
  const mineDeleted = await db('recipes').where({ user_id: req.session.user.id }).whereNotNull('deleted_at').orderBy('deleted_at', 'desc');
  res.render('trash/index', { user: req.session.user, mineDeleted, pageTitle: 'Corbeille' });
});
app.post('/trash/:id/restore', requireAuth, async (req, res) => {
  const rec = await db('recipes').where({ id: req.params.id }).first();
  if (!rec) return res.status(404).render('404', { user: req.session.user });
  if (rec.user_id !== req.session.user.id) return res.redirect('/');
  await db('recipes').where({ id: rec.id }).update({ deleted_at: null, updated_at: now() });
  flash(req, 'success', 'Recette restaurée ✅');
  res.redirect('/recipes/' + rec.id);
});
app.post('/trash/:id/purge', requireAuth, async (req, res) => {
  const rec = await db('recipes').where({ id: req.params.id }).first();
  if (!rec) return res.status(404).render('404', { user: req.session.user });
  if (rec.user_id !== req.session.user.id) return res.redirect('/');
  await db('recipes').where({ id: rec.id }).del();
  flash(req, 'success', 'Recette supprimée définitivement 🗑️');
  res.redirect('/trash');
});

// Admin local: orphelins uploads
app.get('/admin/orphans', requireAuth, async (req, res) => {
  const uploadDir = path.join(__dirname, 'public', 'uploads');
  let files = [];
  try { files = fs.readdirSync(uploadDir); } catch (e) {}
  const used = await db('recipes').pluck('image_path');
  const usedNames = new Set(
    used
      .filter((p) => p && p.startsWith('/public/uploads/'))
      .map((p) => p.replace('/public/uploads/', ''))
  );
  const orphans = files.filter((f) => !usedNames.has(f));
  res.render('admin/orphans', { user: req.session.user, orphans, pageTitle: 'Nettoyage images' });
});
app.post('/admin/orphans/cleanup', requireAuth, async (req, res) => {
  const toDelete = (req.body.files || '').split(',').map((s) => s.trim()).filter(Boolean);
  const uploadDir = path.join(__dirname, 'public', 'uploads');
  for (const f of toDelete) {
    try { fs.unlinkSync(path.join(uploadDir, f)); } catch (e) {}
  }
  flash(req, 'success', 'Nettoyage effectué 🧹');
  res.redirect('/admin/orphans');
});

/* ───────────────── 404 & 500 (plus JAMAIS 403) ───────────────── */
app.use((req, res) => res.status(404).render('404', { user: req.session?.user, pageTitle: '404' }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('500', { user: req.session?.user, pageTitle: 'Erreur' });
});

/* ───────────────── Start ───────────────── */
app.listen(PORT, () => {
  console.log('LetHimCook running on http://localhost:' + PORT);
});
