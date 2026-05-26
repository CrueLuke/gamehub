"""Piškvorky — backend server.

Spuštění:   python3 server.py
Server pak poslouchá na http://localhost:5000
"""
import base64
import hashlib
import json
import os
import random
import secrets
import sqlite3
import string

from flask import Flask, jsonify, request, send_from_directory, session
from flask_socketio import SocketIO, emit, join_room

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATABASE_URL = os.environ.get('DATABASE_URL')
USE_POSTGRES = bool(DATABASE_URL)

# Gemini AI (pro Drawing Competition) — volitelné, pokud klíč není, hra padne na žert
GEMINI_API_KEY = os.environ.get('GEMINI_API_KEY')
gemini_client = None
try:
    if GEMINI_API_KEY:
        from google import genai
        from google.genai import types as genai_types
        gemini_client = genai.Client(api_key=GEMINI_API_KEY)
        print('Gemini AI: ready ✓')
    else:
        print('Gemini AI: GEMINI_API_KEY není nastavený, Drawing Competition pojede offline.')
except Exception as _e:
    print(f'Gemini AI init selhal: {_e}')
    gemini_client = None

# Postgres (na produkci) vs SQLite (lokálně, fallback)
if USE_POSTGRES:
    import psycopg2
    import psycopg2.extras
    _INTEGRITY_ERROR = psycopg2.IntegrityError
else:
    DB_PATH = os.path.join(BASE_DIR, 'users.db')
    _INTEGRITY_ERROR = sqlite3.IntegrityError

app = Flask(__name__, static_folder='static')
app.secret_key = os.environ.get('SECRET_KEY') or secrets.token_hex(32)
socketio = SocketIO(app, async_mode='threading', cors_allowed_origins='*')

MODE_CONFIG = {
    'classic': {'size': 3, 'win_len': 3},
    'open':    {'size': 15, 'win_len': 5},
}
STAT_COLS = ('ai_wins', 'ai_losses', 'ai_draws', 'pvp_wins', 'pvp_losses', 'pvp_draws')


# === Databáze ===

def _connect():
    if USE_POSTGRES:
        return psycopg2.connect(DATABASE_URL, cursor_factory=psycopg2.extras.RealDictCursor)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def db_run(sql, params=(), *, commit=False, fetchone=False, fetchall=False):
    """One-shot dotaz. Otevře spojení, provede, uzavře. Vrátí row(s) podle parametru."""
    if USE_POSTGRES:
        sql = sql.replace('?', '%s')   # SQLite styl ? → Postgres styl %s
    conn = _connect()
    try:
        cursor = conn.cursor()
        cursor.execute(sql, params)
        if commit:
            conn.commit()
        if fetchone:
            return cursor.fetchone()
        if fetchall:
            return cursor.fetchall()
    finally:
        conn.close()


def init_db():
    db_run('''
        CREATE TABLE IF NOT EXISTS users (
            username TEXT PRIMARY KEY,
            password_hash TEXT NOT NULL,
            ai_wins INTEGER DEFAULT 0,
            ai_losses INTEGER DEFAULT 0,
            ai_draws INTEGER DEFAULT 0,
            pvp_wins INTEGER DEFAULT 0,
            pvp_losses INTEGER DEFAULT 0,
            pvp_draws INTEGER DEFAULT 0
        )
    ''', commit=True)


def hash_password(pw: str) -> str:
    return hashlib.sha256(pw.encode('utf-8')).hexdigest()


def stats_from_row(row) -> dict:
    return {col: row[col] for col in STAT_COLS}


def fetch_user(username: str):
    return db_run('SELECT * FROM users WHERE username = ?', (username,), fetchone=True)


def increment_stat(username: str, column: str) -> dict:
    assert column in STAT_COLS  # zabraň SQL injection přes column name
    db_run(f'UPDATE users SET {column} = {column} + 1 WHERE username = ?',
           (username,), commit=True)
    row = fetch_user(username)
    return stats_from_row(row)


# === REST API: auth + stats ===

@app.route('/')
def index():
    return send_from_directory(app.static_folder, 'index.html')


@app.route('/api/register', methods=['POST'])
def api_register():
    data = request.get_json(silent=True) or {}
    username = (data.get('username') or '').strip()
    password = data.get('password') or ''
    if not username or not password:
        return jsonify({'error': 'Vyplň jméno i heslo.'}), 400
    if len(username) > 32:
        return jsonify({'error': 'Jméno je moc dlouhé (max 32 znaků).'}), 400
    try:
        db_run('INSERT INTO users (username, password_hash) VALUES (?, ?)',
               (username, hash_password(password)), commit=True)
    except _INTEGRITY_ERROR:
        return jsonify({'error': 'Uživatel už existuje.'}), 409
    row = fetch_user(username)
    session['username'] = username
    return jsonify({'username': username, 'stats': stats_from_row(row)})


@app.route('/api/login', methods=['POST'])
def api_login():
    data = request.get_json(silent=True) or {}
    username = (data.get('username') or '').strip()
    password = data.get('password') or ''
    row = fetch_user(username)
    if not row:
        return jsonify({'error': 'Uživatel neexistuje.'}), 401
    if row['password_hash'] != hash_password(password):
        return jsonify({'error': 'Špatné heslo.'}), 401
    session['username'] = username
    return jsonify({'username': username, 'stats': stats_from_row(row)})


@app.route('/api/logout', methods=['POST'])
def api_logout():
    session.pop('username', None)
    return jsonify({'ok': True})


@app.route('/api/me', methods=['GET'])
def api_me():
    username = session.get('username')
    if not username:
        return jsonify({'error': 'Nepřihlášený.'}), 401
    row = fetch_user(username)
    if not row:
        session.pop('username', None)
        return jsonify({'error': 'Uživatel nenalezen.'}), 401
    return jsonify({'username': username, 'stats': stats_from_row(row)})


@app.route('/api/record-ai-result', methods=['POST'])
def api_record_ai_result():
    username = session.get('username')
    if not username:
        return jsonify({'error': 'Nepřihlášený.'}), 401
    data = request.get_json(silent=True) or {}
    result = data.get('result')
    column_map = {'win': 'ai_wins', 'loss': 'ai_losses', 'draw': 'ai_draws'}
    if result not in column_map:
        return jsonify({'error': 'Neplatný výsledek.'}), 400
    stats = increment_stat(username, column_map[result])
    return jsonify({'stats': stats})


# === Multiplayer — herní místnosti přes Socket.IO ===

# In-memory stav místností. Pro malou hru OK; po restartu serveru se vyresetuje.
ROOMS = {}            # room_id -> room dict
SID_TO_ROOM = {}      # socket id -> room_id

def gen_room_id() -> str:
    alphabet = string.ascii_uppercase + string.digits
    while True:
        rid = ''.join(secrets.choice(alphabet) for _ in range(6))
        if rid not in ROOMS:
            return rid


def find_winning_line(board, idx, player, size, win_len):
    """Vrátí seznam indexů vítězné řady (≥ win_len v řadě skrze idx), nebo None."""
    r0, c0 = divmod(idx, size)
    for dr, dc in ((0, 1), (1, 0), (1, 1), (1, -1)):
        line = [idx]
        s = 1
        while True:
            r, c = r0 + s * dr, c0 + s * dc
            if not (0 <= r < size and 0 <= c < size): break
            if board[r * size + c] != player: break
            line.append(r * size + c)
            s += 1
        s = 1
        while True:
            r, c = r0 - s * dr, c0 - s * dc
            if not (0 <= r < size and 0 <= c < size): break
            if board[r * size + c] != player: break
            line.append(r * size + c)
            s += 1
        if len(line) >= win_len:
            return line
    return None


def room_state(room):
    """Stav místnosti, který se posílá klientovi."""
    return {
        'room_id': room['id'],
        'mode': room['mode'],
        'size': room['size'],
        'win_len': room['win_len'],
        'players': room['players'],
        'symbols': room['symbols'],
        'board': room['board'],
        'turn': room['players'][room['turn']] if room['status'] == 'playing' else None,
        'status': room['status'],
        'winner': room['winner'],
        'winning_line': room['winning_line'],
        'scores': room.get('scores', {}),
        'wants_rematch': list(room.get('wants_rematch', set())),
        'games_played': room.get('games_played', 0),
        'last_move': room.get('last_move'),
    }


@socketio.on('create_room')
def on_create_room(data):
    username = session.get('username')
    if not username:
        emit('error', {'message': 'Musíš být přihlášený.'})
        return
    mode_name = (data or {}).get('mode', 'classic')
    if mode_name not in MODE_CONFIG:
        emit('error', {'message': 'Neznámý mód.'})
        return
    cfg = MODE_CONFIG[mode_name]
    room_id = gen_room_id()
    ROOMS[room_id] = {
        'id': room_id,
        'mode': mode_name,
        'size': cfg['size'],
        'win_len': cfg['win_len'],
        'players': [username],
        'symbols': {username: 'X'},
        'scores': {username: 0},
        'games_played': 0,
        'wants_rematch': set(),
        'board': [None] * (cfg['size'] * cfg['size']),
        'turn': 0,
        'status': 'waiting',
        'winner': None,
        'winning_line': None,
        'last_move': None,
    }
    join_room(room_id)
    SID_TO_ROOM[request.sid] = room_id
    emit('room_state', room_state(ROOMS[room_id]))


@socketio.on('join_room')
def on_join_room(data):
    username = session.get('username')
    if not username:
        emit('error', {'message': 'Musíš být přihlášený.'})
        return
    room_id = (data or {}).get('room_id', '').upper()
    room = ROOMS.get(room_id)
    if not room:
        emit('error', {'message': 'Místnost neexistuje (nebo už skončila).'})
        return
    join_room(room_id)
    SID_TO_ROOM[request.sid] = room_id
    # Pokud už jsem v místnosti, jen re-sync stavu
    if username in room['players']:
        emit('room_state', room_state(room))
        return
    if len(room['players']) >= 2:
        emit('error', {'message': 'Místnost je plná.'})
        return
    room['players'].append(username)
    room['symbols'][username] = 'O'
    room['scores'][username] = 0
    room['status'] = 'playing'
    socketio.emit('room_state', room_state(room), to=room_id)


@socketio.on('make_move')
def on_make_move(data):
    username = session.get('username')
    if not username:
        emit('error', {'message': 'Musíš být přihlášený.'})
        return
    room_id = SID_TO_ROOM.get(request.sid)
    room = ROOMS.get(room_id) if room_id else None
    if not room:
        emit('error', {'message': 'Nejsi v žádné místnosti.'})
        return
    if room['status'] != 'playing':
        emit('error', {'message': 'Hra neběží.'})
        return
    if room['players'][room['turn']] != username:
        emit('error', {'message': 'Není tvůj tah.'})
        return
    idx = (data or {}).get('index')
    if not isinstance(idx, int) or idx < 0 or idx >= len(room['board']):
        emit('error', {'message': 'Neplatný tah.'})
        return
    if room['board'][idx] is not None:
        emit('error', {'message': 'Pole už je obsazené.'})
        return

    symbol = room['symbols'][username]
    room['board'][idx] = symbol
    room['last_move'] = idx
    line = find_winning_line(room['board'], idx, symbol, room['size'], room['win_len'])
    if line:
        room['status'] = 'over'
        room['winner'] = username
        room['winning_line'] = line
        room['scores'][username] = room['scores'].get(username, 0) + 1
        # zaznamenat statistiky obou hráčů
        opponent = next(p for p in room['players'] if p != username)
        increment_stat(username, 'pvp_wins')
        increment_stat(opponent, 'pvp_losses')
    elif all(cell is not None for cell in room['board']):
        room['status'] = 'over'
        room['winner'] = 'draw'
        for p in room['players']:
            increment_stat(p, 'pvp_draws')
    else:
        room['turn'] = 1 - room['turn']

    socketio.emit('room_state', room_state(room), to=room_id)


@socketio.on('rematch')
def on_rematch(data=None):
    username = session.get('username')
    if not username:
        return
    room_id = SID_TO_ROOM.get(request.sid)
    room = ROOMS.get(room_id) if room_id else None
    if not room or room['status'] != 'over' or username not in room['players']:
        return

    room['wants_rematch'].add(username)

    if len(room['wants_rematch']) >= 2:
        # Oba chtějí — spustit novou hru, prohodit symboly (střídání toho, kdo začíná)
        room['games_played'] += 1
        room['board'] = [None] * (room['size'] * room['size'])
        room['status'] = 'playing'
        room['winner'] = None
        room['winning_line'] = None
        room['last_move'] = None
        room['wants_rematch'] = set()
        player_a, player_b = room['players']
        if room['games_played'] % 2 == 1:
            room['symbols'] = {player_a: 'O', player_b: 'X'}
            room['turn'] = 1  # player_b má X, začíná
        else:
            room['symbols'] = {player_a: 'X', player_b: 'O'}
            room['turn'] = 0

    socketio.emit('room_state', room_state(room), to=room_id)


@socketio.on('leave_room')
def on_leave_room(data=None):
    handle_disconnect(request.sid)


@socketio.on('disconnect')
def on_disconnect():
    handle_disconnect(request.sid)


def handle_disconnect(sid):
    # Piškvorky cleanup
    room_id = SID_TO_ROOM.pop(sid, None)
    if room_id:
        room = ROOMS.get(room_id)
        if room:
            socketio.emit('opponent_left', {'room_id': room_id}, to=room_id)
            if room['status'] in ('waiting', 'playing'):
                room['status'] = 'abandoned'
            ROOMS.pop(room_id, None)
    # Drawing Competition cleanup
    dc_room_id = SID_TO_DC_ROOM.pop(sid, None)
    if dc_room_id:
        dc_room = DC_ROOMS.get(dc_room_id)
        if dc_room:
            socketio.emit('dc_opponent_left', {'room_id': dc_room_id}, to=dc_room_id)
            DC_ROOMS.pop(dc_room_id, None)


# === Drawing Competition (DC) ===

THEMES = [
    'auto', 'kočka', 'pes', 'dům', 'strom', 'banán', 'hrad', 'robot',
    'sluníčko', 'srdíčko', 'ryba', 'květina', 'kniha', 'jablko',
    'hodiny', 'mrkev', 'slon', 'žirafa', 'motýl', 'medvěd',
    'pizza', 'míč', 'mrak', 'autobus', 'hruška', 'kuře', 'dort',
    'dárek', 'klobouk', 'klíč', 'tužka', 'kytara', 'raketa',
    'včela', 'tučňák', 'jahoda', 'koruna', 'meč', 'lampa',
]

DC_ROOMS = {}
SID_TO_DC_ROOM = {}


def dc_pick_theme():
    return random.choice(THEMES)


def dc_room_state(room):
    """Stav DC místnosti, který se posílá klientům."""
    state = {
        'room_id': room['id'],
        'players': room['players'],
        'symbols': room.get('symbols', {}),
        'status': room['status'],
        'theme': room.get('theme'),
        'scores': room.get('scores', {}),
        'submitted': list(room.get('submissions', {}).keys()),
        'rounds_played': room.get('rounds_played', 0),
        'wants_next': list(room.get('wants_next', set())),
    }
    # Po dokončení kola pošli obrázky a verdikt (jinak nikoli, ať soupeř nevidí výkres dřív)
    if room['status'] == 'over' and room.get('result'):
        state['result'] = room['result']
        state['submissions'] = room.get('submissions', {})
    return state


def judge_drawings(image_a_b64: str, image_b_b64: str, theme: str) -> dict:
    """Pošle dvě kresby Gemini AI a vrátí verdikt.

    Vrátí: {'winner': 'A'|'B'|'draw', 'duvod': str}
    """
    if not gemini_client:
        return {
            'winner': 'draw',
            'duvod': 'AI hodnocení není dostupné (chybí GEMINI_API_KEY). Berte oba jako vítěze. 🎉',
        }

    # Odstraň "data:image/png;base64," prefix, pokud je tam
    if ',' in image_a_b64:
        image_a_b64 = image_a_b64.split(',', 1)[1]
    if ',' in image_b_b64:
        image_b_b64 = image_b_b64.split(',', 1)[1]

    try:
        image_a_bytes = base64.b64decode(image_a_b64)
        image_b_bytes = base64.b64decode(image_b_b64)
    except Exception as e:
        print(f'[DC] base64 decode error: {e}', flush=True)
        return {'winner': 'draw', 'duvod': f'Chyba při dekódování obrázků: {e}'}

    prompt = (
        f'Jsi vtipný porotce amatérských kreseb. Hodnotíš dvě kresby na téma: "{theme}". '
        f'První přiložený obrázek je KRESBA A, druhý je KRESBA B. '
        f'I když je některá z kreseb prázdná nebo skoro prázdná, dokresli si o ní úsudek a hodnoť. '
        f'Porovnej je a rozhodni, která se VÍC podobá zadanému tématu. '
        f'Pokud jsou si VELMI podobné kvality, vrať "draw". '
        f'Vrať JSON s polem "winner" ("A" / "B" / "draw") a "duvod" '
        f'(krátké vtipné vysvětlení v češtině, max 2 věty).'
    )

    # Postupně zkusíme tři stabilní vision modely (pokud první vyhodí chybu, jdeme dál)
    models_to_try = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash']
    last_error = None

    for model_name in models_to_try:
        try:
            response = gemini_client.models.generate_content(
                model=model_name,
                contents=[
                    genai_types.Part.from_bytes(data=image_a_bytes, mime_type='image/png'),
                    genai_types.Part.from_bytes(data=image_b_bytes, mime_type='image/png'),
                    prompt,
                ],
                config=genai_types.GenerateContentConfig(
                    response_mime_type='application/json',
                ),
            )
            text = (response.text or '').strip()
            print(f'[DC] Gemini model={model_name} raw: {text[:200]}', flush=True)
            # Pokud by Gemini přesto vrátila ```json wrapper, ošetřit
            if text.startswith('```'):
                inner = text.strip('`')
                if inner.lower().startswith('json'):
                    inner = inner[4:]
                text = inner.strip()
            result = json.loads(text)
            winner = result.get('winner', 'draw')
            if winner not in ('A', 'B', 'draw'):
                winner = 'draw'
            duvod = str(result.get('duvod') or 'AI nezanechala komentář.')[:300]
            return {'winner': winner, 'duvod': duvod}
        except Exception as e:
            last_error = f'{type(e).__name__}: {str(e)[:200]}'
            print(f'[DC] Gemini model={model_name} FAILED: {last_error}', flush=True)
            continue

    # Všechny modely selhaly
    return {
        'winner': 'draw',
        'duvod': f'AI měla chvilku — žádný model nezvládl. Berte oba.',
    }


@socketio.on('dc_create_room')
def on_dc_create_room(data=None):
    username = session.get('username')
    if not username:
        emit('error', {'message': 'Musíš být přihlášený.'})
        return
    # Sdílíme generátor s piškvorkami, ale ověříme, že ID nekoliduje
    while True:
        room_id = gen_room_id()
        if room_id not in DC_ROOMS:
            break
    DC_ROOMS[room_id] = {
        'id': room_id,
        'players': [username],
        'symbols': {username: 'A'},
        'scores': {username: 0},
        'submissions': {},
        'status': 'waiting',
        'theme': None,
        'result': None,
        'rounds_played': 0,
        'wants_next': set(),
    }
    join_room(room_id)
    SID_TO_DC_ROOM[request.sid] = room_id
    emit('dc_room_state', dc_room_state(DC_ROOMS[room_id]))


@socketio.on('dc_join_room')
def on_dc_join_room(data):
    username = session.get('username')
    if not username:
        emit('error', {'message': 'Musíš být přihlášený.'})
        return
    room_id = (data or {}).get('room_id', '').upper()
    room = DC_ROOMS.get(room_id)
    if not room:
        emit('error', {'message': 'Místnost neexistuje (nebo už skončila).'})
        return
    join_room(room_id)
    SID_TO_DC_ROOM[request.sid] = room_id
    if username in room['players']:
        emit('dc_room_state', dc_room_state(room))
        return
    if len(room['players']) >= 2:
        emit('error', {'message': 'Místnost je plná.'})
        return
    room['players'].append(username)
    room['symbols'][username] = 'B'
    room['scores'][username] = 0
    room['status'] = 'drawing'
    room['theme'] = dc_pick_theme()
    socketio.emit('dc_room_state', dc_room_state(room), to=room_id)


@socketio.on('dc_submit_drawing')
def on_dc_submit_drawing(data):
    username = session.get('username')
    if not username:
        return
    room_id = SID_TO_DC_ROOM.get(request.sid)
    room = DC_ROOMS.get(room_id) if room_id else None
    if not room or room['status'] != 'drawing':
        return
    if username not in room['players']:
        return
    image_b64 = (data or {}).get('image')
    if not image_b64 or not isinstance(image_b64, str):
        emit('error', {'message': 'Neplatný obrázek.'})
        return
    # Limit velikosti (~5MB base64)
    if len(image_b64) > 5 * 1024 * 1024:
        emit('error', {'message': 'Obrázek je moc velký.'})
        return

    room['submissions'][username] = image_b64

    if len(room['submissions']) == 2:
        # Oba poslali → AI hodnotí
        room['status'] = 'judging'
        socketio.emit('dc_room_state', dc_room_state(room), to=room_id)

        player_a, player_b = room['players']
        verdict = judge_drawings(
            room['submissions'][player_a],
            room['submissions'][player_b],
            room['theme'],
        )

        winner_user = None
        if verdict['winner'] == 'A':
            winner_user = player_a
        elif verdict['winner'] == 'B':
            winner_user = player_b

        room['result'] = {
            'winner': winner_user,           # None = remíza
            'duvod': verdict['duvod'],
            'theme': room['theme'],
        }
        if winner_user:
            room['scores'][winner_user] = room['scores'].get(winner_user, 0) + 1
        room['status'] = 'over'
        room['rounds_played'] = room.get('rounds_played', 0) + 1

        socketio.emit('dc_room_state', dc_room_state(room), to=room_id)
    else:
        # Jen oznámit, že jeden už poslal (druhý vidí v UI)
        socketio.emit('dc_room_state', dc_room_state(room), to=room_id)


@socketio.on('dc_next_round')
def on_dc_next_round(data=None):
    username = session.get('username')
    if not username:
        return
    room_id = SID_TO_DC_ROOM.get(request.sid)
    room = DC_ROOMS.get(room_id) if room_id else None
    if not room or room['status'] != 'over' or username not in room['players']:
        return

    room['wants_next'].add(username)

    if len(room['wants_next']) >= 2:
        room['submissions'] = {}
        room['status'] = 'drawing'
        room['theme'] = dc_pick_theme()
        room['result'] = None
        room['wants_next'] = set()

    socketio.emit('dc_room_state', dc_room_state(room), to=room_id)


# === Run ===

if __name__ == '__main__':
    init_db()
    port = int(os.environ.get('PORT', 5001))
    print(f'Server běží na http://localhost:{port}')
    socketio.run(app, host='0.0.0.0', port=port, debug=False, allow_unsafe_werkzeug=True)
