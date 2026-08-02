'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {AiService, RealtimeTranscriptionClient} = require('../ai-service');

class MemoryStore {
    constructor(options) {
        this.data = structuredClone(options.defaults || {});
    }

    get(key) {
        return this.data[key];
    }

    set(key, value) {
        if (typeof key === 'object') {
            Object.assign(this.data, structuredClone(key));
        } else {
            this.data[key] = structuredClone(value);
        }
    }

    delete(key) {
        delete this.data[key];
    }
}

class FakeWebSocket extends EventEmitter {
    static OPEN = 1;
    static instances = [];

    constructor(url, options) {
        super();
        this.url = url;
        this.options = options;
        this.readyState = 0;
        this.sent = [];
        FakeWebSocket.instances.push(this);
    }

    send(message) {
        this.sent.push(JSON.parse(message));
    }

    close() {
        this.readyState = 3;
    }
}

function fakeSender() {
    return {isDestroyed: function () { return false; }};
}

function pcmChunk(value, durationMs) {
    const sampleCount = Math.round(24000 * ((durationMs || 100) / 1000));
    const buffer = Buffer.alloc(sampleCount * 2);
    for (let index = 0; index < sampleCount; index++) {
        buffer.writeInt16LE(value, index * 2);
    }
    return buffer;
}

function validCallState(overrides) {
    return Object.assign({
        phase: 'development',
        activeTopic: 'identity',
        establishedFacts: ['Собеседник спросил имя'],
        unresolvedQuestions: ['Кто это?'],
        lastInterlocutorAct: 'identity_question',
        lastQuestionOrAction: 'Кто это?',
        emotion: 'neutral',
        callbacks: []
    }, overrides);
}

test('Realtime client uses manual turn commits for gpt-live-transcribe', function () {
    const events = [];
    const client = new RealtimeTranscriptionClient({
        WebSocket: FakeWebSocket,
        getApiKey: function () { return 'test-key'; },
        emit: function (sender, payload) { events.push(payload); },
        now: function () { return 1000; }
    });

    client.start(fakeSender(), 'capture-1');
    const socket = FakeWebSocket.instances.at(-1);
    socket.readyState = FakeWebSocket.OPEN;
    socket.emit('open');

    assert.equal(socket.url.includes('intent=transcription'), true);
    assert.equal(socket.options.headers.Authorization, 'Bearer test-key');
    assert.equal(socket.sent[0].session.audio.input.format.rate, 24000);
    assert.deepEqual(socket.sent[0].session.audio.input.transcription.languages, ['ru']);
    assert.equal(socket.sent[0].session.audio.input.turn_detection, null);

    client.appendAudio(pcmChunk(0));
    client.appendAudio(pcmChunk(0));
    client.appendAudio(pcmChunk(0));
    assert.equal(socket.sent.length, 1);

    client.appendAudio(pcmChunk(2000));
    for (let index = 0; index < 5; index++) {
        client.appendAudio(pcmChunk(0));
    }

    const localItemId = events.find(function (event) { return event.type === 'speech_started'; }).itemId;
    assert.match(localItemId, /^local-\d+$/);
    assert.deepEqual(events.filter(function (event) {
        return ['speech_started', 'speech_stopped'].includes(event.type);
    }).map(function (event) { return [event.type, event.itemId, event.timestamp]; }), [
        ['speech_started', localItemId, 1000],
        ['speech_stopped', localItemId, 1100]
    ]);

    assert.deepEqual(socket.sent.slice(1).map(function (event) { return event.type; }), [
        'input_audio_buffer.append',
        'input_audio_buffer.append',
        'input_audio_buffer.append',
        'input_audio_buffer.append',
        'input_audio_buffer.append',
        'input_audio_buffer.append',
        'input_audio_buffer.append',
        'input_audio_buffer.append',
        'input_audio_buffer.append',
        'input_audio_buffer.commit'
    ]);

    socket.emit('message', Buffer.from(JSON.stringify({
        type: 'input_audio_buffer.committed',
        item_id: 'server-turn'
    })));
    socket.emit('message', Buffer.from(JSON.stringify({
        type: 'conversation.item.input_audio_transcription.delta',
        item_id: 'server-turn',
        delta: 'при'
    })));
    socket.emit('message', Buffer.from(JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'server-turn',
        transcript: 'привет'
    })));

    assert.deepEqual(events.slice(-4).map(function (event) { return event.type; }), [
        'speech_started',
        'speech_stopped',
        'transcript_delta',
        'transcript_completed'
    ]);
    assert.equal(events.at(-2).transcript, 'при');
    assert.equal(events.at(-1).itemId, localItemId);
    assert.equal(events.at(-1).transcript, 'привет');
    assert.equal(events.slice(-4).every(function (event) { return event.itemId === localItemId; }), true);
    assert.equal(events.at(-4).timestamp, 1000);
    assert.equal(events.at(-3).timestamp, 1100);
    assert.equal(events.at(-2).timestamp, 1000);
    assert.equal(events.at(-1).timestamp, 1100);
    assert.equal(client.pendingCommits.length, 0);
    assert.equal(client.openTurns.size, 0);
    assert.equal(client.logicalTurns.size, 0);
    assert.equal(events.every(function (event) { return event.sessionToken === 'capture-1'; }), true);
    client.stop();
    assert.equal(events.at(-1).type, 'status');
    assert.equal(events.at(-1).status, 'stopped');
    assert.equal(events.at(-1).sessionToken, 'capture-1');
});

test('AI start IPC forwards the renderer capture token to Realtime', function () {
    const service = new AiService({Store: MemoryStore, WebSocket: FakeWebSocket, fetch: async function () {}});
    const listeners = new Map();
    const ipcMain = {
        handle: function () {},
        on: function (channel, listener) { listeners.set(channel, listener); }
    };
    const sender = fakeSender();
    let started;
    service.transcription.start = function (receivedSender, sessionToken) {
        started = {sender: receivedSender, sessionToken: sessionToken};
    };

    service.register(ipcMain);
    listeners.get('ai:start')({sender: sender}, 'capture-42');

    assert.equal(started.sender, sender);
    assert.equal(started.sessionToken, 'capture-42');
});

test('logical turn ids stay unique when capture restarts without clearing call history', function () {
    const client = new RealtimeTranscriptionClient({
        WebSocket: FakeWebSocket,
        getApiKey: function () { return 'test-key'; },
        emit: function () {}
    });

    client.start(fakeSender(), 'capture-1');
    const first = client.createLogicalTurn().itemId;
    client.stop(false);
    client.start(fakeSender(), 'capture-2');
    const second = client.createLogicalTurn().itemId;

    assert.equal(first, 'local-1');
    assert.equal(second, 'local-2');
    client.stop(false);
});

test('manual VAD accepts quiet cable speech, keeps hysteresis and commits low-level silence', function () {
    const client = new RealtimeTranscriptionClient({
        WebSocket: FakeWebSocket,
        getApiKey: function () { return 'test-key'; },
        emit: function () {},
        now: function () { return 5000; }
    });
    client.start(fakeSender(), 'quiet-capture');
    const socket = FakeWebSocket.instances.at(-1);
    socket.readyState = FakeWebSocket.OPEN;
    socket.emit('open');

    client.appendAudio(pcmChunk(90));
    assert.equal(socket.sent.length, 1);

    client.appendAudio(pcmChunk(100));
    assert.equal(socket.sent.filter(function (event) {
        return event.type === 'input_audio_buffer.append';
    }).length, 2);

    client.appendAudio(pcmChunk(60));
    assert.equal(socket.sent.some(function (event) { return event.type === 'input_audio_buffer.commit'; }), false);
    for (let index = 0; index < 5; index++) {
        client.appendAudio(pcmChunk(40));
    }

    assert.equal(socket.sent.filter(function (event) {
        return event.type === 'input_audio_buffer.commit';
    }).length, 1);
    assert.equal(client.pendingCommits[0].startedAt, 5000);
    assert.equal(client.pendingCommits[0].stoppedAt, 5200);
    client.stop(false);
});

test('manual VAD keeps continuous speech in one server item until the logical turn stops', function () {
    const events = [];
    const client = new RealtimeTranscriptionClient({
        WebSocket: FakeWebSocket,
        getApiKey: function () { return 'test-key'; },
        emit: function (sender, payload) { events.push(payload); },
        now: function () { return 7000; }
    });
    client.start(fakeSender(), 'long-capture');
    const socket = FakeWebSocket.instances.at(-1);
    socket.readyState = FakeWebSocket.OPEN;
    socket.emit('open');

    for (let index = 0; index < 200; index++) {
        client.appendAudio(pcmChunk(200));
    }

    const commits = socket.sent.filter(function (event) {
        return event.type === 'input_audio_buffer.commit';
    });
    assert.equal(commits.length, 1);
    assert.equal(client.pendingCommits.length, 1);
    assert.equal(client.pendingCommits[0].reason, 'duration');
    assert.equal(client.pendingCommits[0].durationMs, 20000);
    assert.equal(client.pendingCommits[0].stoppedAt, 27000);
    assert.equal(client.speaking, false);
    const boundaries = events.filter(function (event) {
        return ['speech_started', 'speech_stopped'].includes(event.type);
    });
    assert.equal(boundaries.length, 2);
    assert.equal(boundaries[0].itemId, boundaries[1].itemId);
    assert.deepEqual(boundaries.map(function (event) { return event.timestamp; }), [7000, 27000]);

    client.appendAudio(pcmChunk(200));
    assert.equal(client.speaking, true);
    assert.notEqual(events.filter(function (event) { return event.type === 'speech_started'; }).at(-1).itemId,
        boundaries[0].itemId);
    client.stop(false);
});

test('intentional stop cancels an active local turn without reporting a transcription error', function () {
    const events = [];
    const client = new RealtimeTranscriptionClient({
        WebSocket: FakeWebSocket,
        getApiKey: function () { return 'test-key'; },
        emit: function (sender, payload) { events.push(payload); },
        now: function () { return 8000; }
    });
    client.start(fakeSender(), 'cancel-capture');
    const socket = FakeWebSocket.instances.at(-1);
    socket.readyState = FakeWebSocket.OPEN;
    socket.emit('open');

    client.appendAudio(pcmChunk(200));
    const localItemId = events.find(function (event) { return event.type === 'speech_started'; }).itemId;
    client.stop(false);

    const cancelled = events.find(function (event) { return event.type === 'turn_cancelled'; });
    assert.equal(cancelled.itemId, localItemId);
    assert.equal(cancelled.reason, 'stopped');
    assert.equal(events.some(function (event) { return event.type === 'turn_failed'; }), false);
    assert.equal(client.logicalTurns.size, 0);
    assert.equal(client.audioTurn, null);
});

test('commit acknowledgements keep local turn order when transcriptions complete out of order', function () {
    const events = [];
    let now = 1000;
    const client = new RealtimeTranscriptionClient({
        WebSocket: FakeWebSocket,
        getApiKey: function () { return 'test-key'; },
        emit: function (sender, payload) { events.push(payload); },
        now: function () { return now; }
    });
    client.start(fakeSender(), 'ordered-capture');
    const socket = FakeWebSocket.instances.at(-1);
    socket.readyState = FakeWebSocket.OPEN;
    socket.emit('open');

    client.appendAudio(pcmChunk(200));
    for (let index = 0; index < 5; index++) {
        client.appendAudio(pcmChunk(0));
    }
    now = 2000;
    client.appendAudio(pcmChunk(200));
    for (let index = 0; index < 5; index++) {
        client.appendAudio(pcmChunk(0));
    }

    const startsBeforeAcknowledgement = events.filter(function (event) { return event.type === 'speech_started'; });
    const stopsBeforeAcknowledgement = events.filter(function (event) { return event.type === 'speech_stopped'; });
    assert.equal(startsBeforeAcknowledgement.length, 2);
    assert.equal(stopsBeforeAcknowledgement.length, 2);
    const firstLocalId = startsBeforeAcknowledgement[0].itemId;
    const secondLocalId = startsBeforeAcknowledgement[1].itemId;

    socket.emit('message', Buffer.from(JSON.stringify({
        type: 'input_audio_buffer.committed',
        item_id: 'first'
    })));
    socket.emit('message', Buffer.from(JSON.stringify({
        type: 'input_audio_buffer.committed',
        item_id: 'second'
    })));
    socket.emit('message', Buffer.from(JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'second',
        transcript: 'два'
    })));
    socket.emit('message', Buffer.from(JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'first',
        transcript: 'один'
    })));

    const starts = events.filter(function (event) { return event.type === 'speech_started'; });
    const completed = events.filter(function (event) { return event.type === 'transcript_completed'; });
    assert.deepEqual(starts.map(function (event) { return [event.itemId, event.timestamp]; }), [
        [firstLocalId, 1000],
        [secondLocalId, 2000]
    ]);
    assert.deepEqual(completed.map(function (event) { return [event.itemId, event.timestamp]; }), [
        [secondLocalId, 2100],
        [firstLocalId, 1100]
    ]);
    assert.equal(events.some(function (event) {
        return ['first', 'second'].includes(event.itemId);
    }), false);
    client.stop(false);
});

test('an early streaming delta is remapped to local timestamps after commit acknowledgement', function () {
    const events = [];
    let now = 1000;
    const client = new RealtimeTranscriptionClient({
        WebSocket: FakeWebSocket,
        getApiKey: function () { return 'test-key'; },
        emit: function (sender, payload) { events.push(payload); },
        now: function () { return now; }
    });
    client.start(fakeSender(), 'streaming-capture');
    const socket = FakeWebSocket.instances.at(-1);
    socket.readyState = FakeWebSocket.OPEN;
    socket.emit('open');

    client.appendAudio(pcmChunk(200));
    const localItemId = events.find(function (event) { return event.type === 'speech_started'; }).itemId;
    now = 1050;
    socket.emit('message', Buffer.from(JSON.stringify({
        type: 'conversation.item.input_audio_transcription.delta',
        item_id: 'streaming-turn',
        delta: 'при'
    })));
    assert.equal(client.unmappedTurns.has('streaming-turn'), true);

    for (let index = 0; index < 5; index++) {
        client.appendAudio(pcmChunk(0));
    }
    now = 1200;
    socket.emit('message', Buffer.from(JSON.stringify({
        type: 'input_audio_buffer.committed',
        item_id: 'streaming-turn'
    })));
    socket.emit('message', Buffer.from(JSON.stringify({
        type: 'conversation.item.input_audio_transcription.delta',
        item_id: 'streaming-turn',
        delta: 'вет'
    })));

    assert.equal(client.unmappedTurns.has('streaming-turn'), false);
    assert.equal(client.openTurns.get('streaming-turn').startedAt, 1000);
    assert.equal(events.find(function (event) {
        return event.type === 'speech_started' && event.itemId === localItemId;
    }).timestamp, 1000);
    const deltas = events.filter(function (event) {
        return event.type === 'transcript_delta' && event.itemId === 'streaming-turn';
    });
    assert.equal(deltas.length, 0);
    const localDeltas = events.filter(function (event) {
        return event.type === 'transcript_delta' && event.itemId === localItemId;
    });
    assert.equal(localDeltas.at(-1).timestamp, 1000);
    assert.equal(localDeltas.at(-1).transcript, 'привет');
    client.stop(false);
});

test('an unknown delta maps to the oldest committed turn before a newer active turn', function () {
    const events = [];
    let now = 1000;
    const client = new RealtimeTranscriptionClient({
        WebSocket: FakeWebSocket,
        getApiKey: function () { return 'test-key'; },
        emit: function (sender, payload) { events.push(payload); },
        now: function () { return now; }
    });
    client.start(fakeSender(), 'pending-before-active');
    const socket = FakeWebSocket.instances.at(-1);
    socket.readyState = FakeWebSocket.OPEN;
    socket.emit('open');

    client.appendAudio(pcmChunk(200));
    const firstLocalId = events.find(function (event) { return event.type === 'speech_started'; }).itemId;
    for (let index = 0; index < 5; index++) {
        client.appendAudio(pcmChunk(0));
    }
    assert.equal(client.pendingCommits.length, 1);

    now = 2000;
    client.appendAudio(pcmChunk(200));
    const secondLocalId = events.filter(function (event) { return event.type === 'speech_started'; }).at(-1).itemId;
    socket.emit('message', Buffer.from(JSON.stringify({
        type: 'conversation.item.input_audio_transcription.delta',
        item_id: 'server-first',
        delta: 'первая'
    })));

    const delta = events.filter(function (event) { return event.type === 'transcript_delta'; }).at(-1);
    assert.equal(delta.itemId, firstLocalId);
    assert.notEqual(delta.itemId, secondLocalId);
    assert.equal(client.unmappedTurns.get('server-first'), client.pendingCommits[0]);
    assert.equal(client.audioTurn.itemId, secondLocalId);
    client.stop(false);
});

test('transcription failure closes only its turn and keeps the session recoverable', function () {
    const events = [];
    const client = new RealtimeTranscriptionClient({
        WebSocket: FakeWebSocket,
        getApiKey: function () { return 'test-key'; },
        emit: function (sender, payload) { events.push(payload); },
        now: function () { return 9000; }
    });
    client.start(fakeSender(), 'failed-capture');
    const socket = FakeWebSocket.instances.at(-1);
    socket.readyState = FakeWebSocket.OPEN;
    socket.emit('open');
    client.appendAudio(pcmChunk(200));
    const localItemId = events.find(function (event) { return event.type === 'speech_started'; }).itemId;
    for (let index = 0; index < 5; index++) {
        client.appendAudio(pcmChunk(0));
    }
    socket.emit('message', Buffer.from(JSON.stringify({
        type: 'input_audio_buffer.committed',
        item_id: 'failed-turn'
    })));
    socket.emit('message', Buffer.from(JSON.stringify({
        type: 'conversation.item.input_audio_transcription.failed',
        item_id: 'failed-turn',
        error: {code: 'audio_unintelligible', message: 'No speech recognized'}
    })));

    const failure = events.find(function (event) { return event.type === 'turn_failed'; });
    assert.equal(failure.itemId, localItemId);
    assert.equal(failure.error.code, 'audio_unintelligible');
    assert.equal(failure.sessionToken, 'failed-capture');
    assert.equal(client.openTurns.size, 0);
    assert.equal(client.logicalTurns.size, 0);
    assert.equal(client.active, true);
    assert.equal(client.socket, socket);
    client.stop(false);
});

test('unexpected socket close fails mapped turns and clears all manual VAD buffers', function () {
    const events = [];
    const client = new RealtimeTranscriptionClient({
        WebSocket: FakeWebSocket,
        getApiKey: function () { return 'test-key'; },
        emit: function (sender, payload) { events.push(payload); },
        now: function () { return 11000; },
        setTimeout: function () { return 1; },
        clearTimeout: function () {}
    });
    client.start(fakeSender(), 'reconnect-capture');
    const socket = FakeWebSocket.instances.at(-1);
    socket.readyState = FakeWebSocket.OPEN;
    socket.emit('open');
    client.appendAudio(pcmChunk(200));
    const firstLocalId = events.find(function (event) { return event.type === 'speech_started'; }).itemId;
    for (let index = 0; index < 5; index++) {
        client.appendAudio(pcmChunk(0));
    }
    socket.emit('message', Buffer.from(JSON.stringify({
        type: 'input_audio_buffer.committed',
        item_id: 'open-turn'
    })));
    client.appendAudio(pcmChunk(200));
    const secondLocalId = events.filter(function (event) { return event.type === 'speech_started'; }).at(-1).itemId;
    socket.emit('message', Buffer.from(JSON.stringify({
        type: 'conversation.item.input_audio_transcription.delta',
        item_id: 'streaming-turn',
        delta: 'незаконченная реплика'
    })));

    socket.emit('close');

    const failure = events.find(function (event) {
        return event.type === 'turn_failed' && event.itemId === firstLocalId;
    });
    assert.equal(failure.error.code, 'connection_lost');
    assert.equal(events.some(function (event) {
        return event.type === 'turn_failed' && event.itemId === secondLocalId &&
            event.error.code === 'connection_lost';
    }), true);
    assert.equal(client.openTurns.size, 0);
    assert.equal(client.unmappedTurns.size, 0);
    assert.equal(client.pendingCommits.length, 0);
    assert.equal(client.logicalTurns.size, 0);
    assert.equal(client.prefixAudio.length, 0);
    assert.equal(client.audioTurn, null);
    assert.equal(client.speaking, false);
    assert.equal(events.at(-1).status, 'reconnecting');
});

test('Realtime reconnect uses bounded exponential backoff', function () {
    const events = [];
    const delays = [];
    const client = new RealtimeTranscriptionClient({
        WebSocket: FakeWebSocket,
        getApiKey: function () { return 'test-key'; },
        emit: function (sender, payload) { events.push(payload); },
        setTimeout: function (callback, delay) {
            delays.push(delay);
            return delays.length;
        },
        clearTimeout: function () {}
    });
    client.sender = fakeSender();
    client.active = true;

    for (let i = 0; i < 6; i++) {
        client.scheduleReconnect();
    }

    assert.deepEqual(delays, [500, 1000, 2000, 4000, 5000]);
    assert.equal(client.active, false);
    assert.equal(events.at(-1).error.code, 'reconnect_failed');
});

test('AI settings store multiple prank scenarios and reject incomplete drafts', function () {
    const service = new AiService({Store: MemoryStore, WebSocket: FakeWebSocket, fetch: async function () {}});
    const settings = service.setSettings({
        scenarios: [
            {id: 'utility', name: 'ЖКХ', prompt: 'Следовать плану ЖКХ'},
            {id: 'bank', name: 'Банк', prompt: 'Следовать плану банка'},
            {id: 'draft', name: '', prompt: ''}
        ],
        activeScenarioId: 'bank'
    });

    assert.deepEqual(settings.scenarios.map(function (scenario) { return scenario.id; }), ['utility', 'bank']);
    assert.equal(settings.activeScenarioId, 'bank');
});

test('candidate sanitizer caps one character page and overwrites foreign page metadata', function () {
    const service = new AiService({Store: MemoryStore, WebSocket: FakeWebSocket, fetch: async function () {}});
    const candidates = Array.from({length: 600}, function (value, index) {
        return {hash: 'sound-' + index, text: 'Фраза ' + index, pageHash: 'page-' + (index % 3)};
    });
    const sanitized = service.sanitizeCandidates(candidates, 'current-character');

    assert.equal(sanitized.length, 500);
    assert.equal(sanitized.every(function (candidate) {
        return candidate.pageHash === 'current-character';
    }), true);
});

test('recent-play context only uses responses from the current character', function () {
    const service = new AiService({Store: MemoryStore, WebSocket: FakeWebSocket, fetch: async function () {}});
    const hashes = service.recentPlayedHashes([{
        played: [
            {hash: 'bank-answer', pageHash: 'bank'},
            {hash: 'police-answer', pageHash: 'police'}
        ]
    }], [{hash: 'bank-now', pageHash: 'bank'}], 'bank');

    assert.deepEqual(hashes, ['bank-answer', 'bank-now']);
});

test('page index embeds only new, renamed or changed labels and removes stale entries', async function () {
    const embeddingRequests = [];
    const fakeFetch = async function (url, options) {
        const body = JSON.parse(options.body);
        embeddingRequests.push(body.input);
        return {
            ok: true,
            json: async function () {
                return {
                    data: body.input.map(function (text, index) {
                        return {index: index, embedding: [text.length, 1]};
                    })
                };
            }
        };
    };
    const service = new AiService({Store: MemoryStore, WebSocket: FakeWebSocket, fetch: fakeFetch});
    service.setSettings({apiKey: 'test'});

    await service.ensurePageIndex('page', [{hash: 'a', text: 'один'}, {hash: 'b', text: 'два'}]);
    await service.ensurePageIndex('page', [{hash: 'a', text: 'один'}, {hash: 'b', text: 'два'}]);
    await service.ensurePageIndex('page', [{hash: 'b', text: 'изменено'}]);

    assert.equal(embeddingRequests.length, 2);
    assert.equal(embeddingRequests[0][0].includes('Записанная реплика: один'), true);
    assert.equal(embeddingRequests[0][0].includes('Речевой акт'), true);
    assert.equal(embeddingRequests[1][0].includes('Записанная реплика: изменено'), true);
    assert.deepEqual(Object.keys(service.indexStore.get('pages').page.entries), ['b']);
    assert.equal(service.indexStore.get('pages').page.descriptorVersion, 2);
    assert.equal(service.indexStore.get('pages').page.entries.b.metadata.dialogueAct, 'statement');
});

test('late final ranking does not block a new turn and rejects invented ids', async function () {
    const service = new AiService({Store: MemoryStore, WebSocket: FakeWebSocket, fetch: async function () {}});
    service.indexStore.set('pages', {
        page: {
            model: 'text-embedding-3-small',
            dimensions: 512,
            entries: {
                a: {text: 'A', checksum: 'a', embedding: [1, 0]},
                b: {text: 'B', checksum: 'b', embedding: [0.8, 0.2]}
            }
        }
    });
    service.ensurePageIndex = async function () {};
    service.embedTexts = async function () { return [[1, 0]]; };
    let finishModel;
    service.rankWithModel = function () {
        return new Promise(function (resolve) { finishModel = resolve; });
    };
    let finishEvent;
    const rankingEvent = new Promise(function (resolve) { finishEvent = resolve; });
    const sender = {
        isDestroyed: function () { return false; },
        send: function (channel, event) { finishEvent({channel: channel, event: event}); }
    };

    const initial = await service.rank({
        turnId: 'turn',
        pageHash: 'page',
        revision: 1,
        transcript: 'текст',
        context: 'текст',
        scenario: {id: 'scenario', name: 'Проверка', prompt: 'Следуй плану'},
        history: [],
        candidates: [{hash: 'a', text: 'A'}, {hash: 'b', text: 'B'}],
        final: true
    }, sender);
    const nextTurn = await service.rank({
        turnId: 'next',
        pageHash: 'page',
        revision: 1,
        transcript: 'новая реплика',
        scenario: {id: 'scenario', name: 'Проверка', prompt: 'Следуй плану'},
        history: [],
        candidates: [{hash: 'a', text: 'A'}, {hash: 'b', text: 'B'}],
        final: false
    }, sender);

    assert.equal(initial.final, false);
    assert.equal(initial.source, 'semantic');
    assert.deepEqual(nextTurn.suggestions.map(function (item) { return item.hash; }), ['a', 'b']);

    finishModel(['invented', 'b']);
    const late = await rankingEvent;
    assert.equal(late.channel, 'ai:event');
    assert.equal(late.event.type, 'ranking');
    assert.equal(late.event.result.source, 'model');
    assert.deepEqual(late.event.result.suggestions.map(function (item) { return item.hash; }), ['b', 'a']);
});

test('model ranking schema requests the available top-k from existing ids', async function () {
    const service = new AiService({Store: MemoryStore, WebSocket: FakeWebSocket, fetch: async function () {}});
    let requestBody;
    service.requestJson = async function (path, body) {
        requestBody = body;
        return {output_text: JSON.stringify({
            ids: ['a', 'b'],
            callState: validCallState()
        })};
    };

    const ranking = await service.rankWithModel(
        {
            scenario: {id: 'scenario', name: 'Проверка', prompt: 'Следуй плану'},
            currentTranscript: 'контекст',
            recentHistory: [],
            relevantHistory: [],
            playedHistory: [],
            recentHashes: []
        },
        [{hash: 'a', text: 'A'}, {hash: 'b', text: 'B'}],
        [],
        [{hash: 'a', text: 'A'}, {hash: 'b', text: 'B'}]
    );
    const schema = requestBody.text.format.schema.properties.ids;

    assert.deepEqual(ranking.ids, ['a', 'b']);
    assert.equal(ranking.callState.phase, 'development');
    assert.equal(schema.minItems, 2);
    assert.equal(schema.maxItems, 2);
    assert.equal(Object.hasOwn(schema, 'uniqueItems'), false);
    assert.deepEqual(schema.items.enum, ['a', 'b']);
    assert.deepEqual(Object.keys(requestBody.text.format.schema.properties), ['ids', 'callState']);
    assert.equal(requestBody.text.format.strict, true);
    assert.equal(requestBody.text.format.schema.additionalProperties, false);
    assert.deepEqual(
        requestBody.text.format.schema.required,
        Object.keys(requestBody.text.format.schema.properties)
    );
    assert.equal(requestBody.text.format.schema.properties.callState.additionalProperties, false);
    assert.deepEqual(
        requestBody.text.format.schema.properties.callState.required,
        Object.keys(requestBody.text.format.schema.properties.callState.properties)
    );
    assert.equal(requestBody.input[1].content.some(function (item) {
        return item.text.includes('Следуй плану');
    }), true);
    assert.equal(requestBody.input[1].content[0].text.includes('САМАЯ НОВАЯ РЕПЛИКА'), true);
    assert.equal(requestBody.input[0].content[0].text.includes('Ничего не сочиняй'), true);
    assert.equal(requestBody.input[0].content[0].text.includes('абсурдной петли'), true);
    assert.equal(requestBody.input[0].content[0].text.includes('scenario.plan.facts каноничны'), true);
});

test('model ranking rejects malformed state and ids outside the application contract', async function () {
    const service = new AiService({Store: MemoryStore, WebSocket: FakeWebSocket, fetch: async function () {}});
    const shortlist = [{hash: 'a', text: 'A'}, {hash: 'b', text: 'B'}];
    const payload = {
        scenario: {id: 'scenario', name: 'Проверка', prompt: 'Следуй плану'},
        currentTranscript: 'контекст',
        recentHistory: [],
        relevantHistory: [],
        playedHistory: [],
        recentHashes: []
    };
    const responses = [
        {ids: ['a', 'b']},
        {ids: ['a', 'b'], callState: validCallState({callbacks: [123]})},
        {ids: ['a', 'a'], callState: validCallState()},
        {ids: ['a', 'invented'], callState: validCallState()},
        {ids: ['a'], callState: validCallState()}
    ];

    for (const response of responses) {
        service.requestJson = async function () {
            return {output_text: JSON.stringify(response)};
        };
        await assert.rejects(
            service.rankWithModel(payload, shortlist, [], shortlist),
            /Invalid ranking response contract/
        );
    }
});

test('invalid model JSON keeps the semantic result', async function () {
    const service = new AiService({Store: MemoryStore, WebSocket: FakeWebSocket, fetch: async function () {}});
    service.indexStore.set('pages', {
        page: {
            model: 'text-embedding-3-small',
            dimensions: 512,
            entries: {a: {text: 'A', checksum: 'a', embedding: [1, 0]}}
        }
    });
    service.ensurePageIndex = async function () {};
    service.embedTexts = async function () { return [[1, 0]]; };
    service.rankWithModel = async function () { JSON.parse('not-json'); };
    let finishEvent;
    const rankingEvent = new Promise(function (resolve) { finishEvent = resolve; });
    const sender = {
        isDestroyed: function () { return false; },
        send: function (channel, event) { finishEvent(event); }
    };

    const initial = await service.rank({
        turnId: 'turn',
        pageHash: 'page',
        revision: 1,
        transcript: 'текст',
        scenario: {id: 'scenario', name: 'Проверка', prompt: 'Следуй плану'},
        history: [],
        candidates: [{hash: 'a', text: 'A', pageHash: 'other-character'}],
        final: true
    }, sender);
    const fallback = await rankingEvent;

    assert.deepEqual(initial.suggestions, [{hash: 'a', text: 'A', tactic: 'scenario'}]);
    assert.equal(fallback.result.source, 'semantic');
    assert.equal(fallback.result.final, true);
    assert.equal(fallback.result.fallbackError.code, 'unknown');
});

test('missing model call state falls back without resetting the current call state', async function () {
    const service = new AiService({Store: MemoryStore, WebSocket: FakeWebSocket, fetch: async function () {}});
    service.indexStore.set('pages', {
        page: {
            model: 'text-embedding-3-small',
            dimensions: 512,
            entries: {a: {text: 'A', checksum: 'a', embedding: [1, 0]}}
        }
    });
    service.ensurePageIndex = async function () {};
    service.embedTexts = async function (texts) {
        return texts.map(function () { return [1, 0]; });
    };
    service.requestJson = async function () {
        return {output_text: JSON.stringify({ids: ['a']})};
    };
    const currentState = validCallState({
        phase: 'escalation',
        activeTopic: 'money',
        emotion: 'angry'
    });
    let resolveEvent;
    const rankingEvent = new Promise(function (resolve) { resolveEvent = resolve; });
    const sender = {
        isDestroyed: function () { return false; },
        send: function (channel, event) { resolveEvent(event); }
    };

    const initial = await service.rank({
        turnId: 'turn',
        pageHash: 'page',
        revision: 1,
        transcript: 'текст',
        scenario: {id: 'scenario', name: 'Проверка', prompt: 'Следуй плану'},
        history: [],
        callState: currentState,
        candidates: [{hash: 'a', text: 'A'}],
        final: true
    }, sender);
    const fallback = await rankingEvent;

    assert.deepEqual(initial.callState, currentState);
    assert.equal(fallback.result.source, 'semantic');
    assert.equal(fallback.result.final, true);
    assert.deepEqual(fallback.result.callState, currentState);
});

test('feedback service passes the original turn start time into memory', async function () {
    const service = new AiService({Store: MemoryStore, WebSocket: FakeWebSocket, fetch: async function () {}});
    service.embedTexts = async function () { return [[1, 0]]; };
    await service.saveFeedback({
        turnId: 'root\u0000page',
        rootTurnId: 'root',
        pageHash: 'page',
        scenarioId: 'scenario',
        transcript: 'Кто это?',
        context: 'Собеседник: Кто это?',
        selections: [{blockHash: 'answer'}],
        startedAt: '2026-08-02T15:00:00.000Z'
    });

    assert.equal(service.feedbackStore.get('turnLog')[0].startedAt, '2026-08-02T15:00:00.000Z');
});

test('HTTP timeout is normalized for the renderer', async function () {
    const service = new AiService({
        Store: MemoryStore,
        WebSocket: FakeWebSocket,
        fetch: function (url, options) {
            return new Promise(function (resolve, reject) {
                options.signal.addEventListener('abort', function () {
                    const error = new Error('aborted');
                    error.name = 'AbortError';
                    reject(error);
                });
            });
        }
    });
    service.setSettings({apiKey: 'test'});

    await assert.rejects(
        service.requestJson('/v1/test', {}, 5),
        function (error) { return error.publicError && error.publicError.code === 'timeout'; }
    );
});
