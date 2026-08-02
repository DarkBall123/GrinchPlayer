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

test('Realtime client configures Russian PCM transcription and forwards item-scoped events', function () {
    const events = [];
    const client = new RealtimeTranscriptionClient({
        WebSocket: FakeWebSocket,
        getApiKey: function () { return 'test-key'; },
        emit: function (sender, payload) { events.push(payload); }
    });

    client.start(fakeSender());
    const socket = FakeWebSocket.instances.at(-1);
    socket.readyState = FakeWebSocket.OPEN;
    socket.emit('open');

    assert.equal(socket.url.includes('intent=transcription'), true);
    assert.equal(socket.options.headers.Authorization, 'Bearer test-key');
    assert.equal(socket.sent[0].session.audio.input.format.rate, 24000);
    assert.deepEqual(socket.sent[0].session.audio.input.transcription.languages, ['ru']);
    assert.deepEqual(socket.sent[0].session.audio.input.turn_detection, {
        type: 'server_vad',
        threshold: 0.5,
        prefix_padding_ms: 300,
        silence_duration_ms: 450
    });

    client.appendAudio(Uint8Array.from([1, 2, 3]));
    assert.equal(socket.sent[1].type, 'input_audio_buffer.append');
    assert.equal(socket.sent[1].audio, 'AQID');

    socket.emit('message', Buffer.from(JSON.stringify({
        type: 'input_audio_buffer.speech_started',
        item_id: 'server-turn'
    })));
    socket.emit('message', Buffer.from(JSON.stringify({
        type: 'conversation.item.input_audio_transcription.delta',
        item_id: 'server-turn',
        delta: 'при'
    })));
    socket.emit('message', Buffer.from(JSON.stringify({
        type: 'input_audio_buffer.speech_stopped',
        item_id: 'server-turn'
    })));
    socket.emit('message', Buffer.from(JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'server-turn',
        transcript: 'привет'
    })));

    assert.deepEqual(events.slice(-4).map(function (event) { return event.type; }), [
        'speech_started',
        'transcript_delta',
        'speech_stopped',
        'transcript_completed'
    ]);
    assert.equal(events.at(-1).itemId, 'server-turn');
    client.stop(false);
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

test('recent-play penalty only uses responses from the current character', function () {
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

    assert.deepEqual(embeddingRequests, [['один', 'два'], ['изменено']]);
    assert.deepEqual(Object.keys(service.indexStore.get('pages').page.entries), ['b']);
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
        return {output_text: JSON.stringify({ids: ['a', 'b']})};
    };

    const ids = await service.rankWithModel(
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

    assert.deepEqual(ids, ['a', 'b']);
    assert.equal(schema.minItems, 2);
    assert.equal(schema.maxItems, 2);
    assert.equal(schema.uniqueItems, true);
    assert.deepEqual(schema.items.enum, ['a', 'b']);
    assert.deepEqual(Object.keys(requestBody.text.format.schema.properties), ['ids']);
    assert.equal(requestBody.input[1].content[0].text.includes('Следуй плану'), true);
    assert.equal(requestBody.input[0].content[0].text.includes('Не сочиняй'), true);
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

    assert.deepEqual(initial.suggestions, [{hash: 'a', text: 'A'}]);
    assert.equal(fallback.result.source, 'semantic');
    assert.equal(fallback.result.final, true);
    assert.equal(fallback.result.fallbackError.code, 'unknown');
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
