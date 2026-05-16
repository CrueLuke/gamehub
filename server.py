"""Piškvorky — backend server.

Spuštění:   python3 server.py
Server pak poslouchá na http://localhost:5000
"""
import hashlib
import os
import secrets
import sqlite3
import string

from flask import Flask, jsonify, request, send_from_directory, session
from flask_socketio import SocketIO, emit, join_room

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, 'users.db')

app = Flask(__name__, static_folder='static')
app.secret_key = os.environ.get('SECRET_KEY') or secrets.token_hex(32)
socketio = SocketIO(app, async_mode='threading', cors_allowed_origins='*')

MODE_CONFIG = {
    'classic': {'size': 3, 'win_len': 3},
    'open':    {'size': 15, 'win_len': 5},
}
STAT_COLS = ('ai_wins', 'ai_losses', 'ai_draws', 'pvp_wins', 'pvp_losses', 'pvp_draws')


# === Databáze ===

def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = db()
    conn.execute('''
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
    ''')
    conn.commit()
    conn.close()


def hash_password(pw: str) -> str:
    return hashlib.sha256(pw.encode('utf-8')).hexdigest()


def stats_from_row(row) -> dict:
    return {col: row[col] for col in STAT_COLS}


def fetch_user(username: str):
    conn = db()
    row = conn.execute('SELECT * FROM users WHERE username = ?', (username,)).fetchone()
    conn.close()
    return row


def increment_stat(username: str, column: str) -> dict:
    assert column in STAT_COLS  # zabraň SQL injection přes column name
    conn = db()
    conn.execute(f'UPDATE users SET {column} = {column} + 1 WHERE username = ?', (username,))
    conn.commit()
    row = conn.execute('SELECT * FROM users WHERE username = ?', (username,)).fetchone()
    conn.close()
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
    conn = db()
    try:
        conn.execute('INSERT INTO users (username, password_hash) VALUES (?, ?)',
                     (username, hash_password(password)))
        conn.commit()
    except sqlite3.IntegrityError:
        conn.close()
        return jsonify({'error': 'Uživatel už existuje.'}), 409
    row = conn.execute('SELECT * FROM users WHERE username = ?', (username,)).fetchone()
    conn.close()
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
        'board': [None] * (cfg['size'] * cfg['size']),
        'turn': 0,
        'status': 'waiting',
        'winner': None,
        'winning_line': None,
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
    line = find_winning_line(room['board'], idx, symbol, room['size'], room['win_len'])
    if line:
        room['status'] = 'over'
        room['winner'] = username
        room['winning_line'] = line
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


@socketio.on('leave_room')
def on_leave_room(data=None):
    handle_disconnect(request.sid)


@socketio.on('disconnect')
def on_disconnect():
    handle_disconnect(request.sid)


def handle_disconnect(sid):
    room_id = SID_TO_ROOM.pop(sid, None)
    if not room_id:
        return
    room = ROOMS.get(room_id)
    if not room:
        return
    # Když ještě hra běžela a někdo odešel, oznam to druhému a zruš místnost
    if room['status'] in ('waiting', 'playing'):
        room['status'] = 'abandoned'
        socketio.emit('opponent_left', {'room_id': room_id}, to=room_id)
    # Vyčistíme dokončené/opuštěné místnosti
    if room['status'] in ('over', 'abandoned'):
        ROOMS.pop(room_id, None)


# === Run ===

if __name__ == '__main__':
    init_db()
    port = int(os.environ.get('PORT', 5001))
    print(f'Server běží na http://localhost:{port}')
    socketio.run(app, host='0.0.0.0', port=port, debug=False, allow_unsafe_werkzeug=True)
