'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    createFeedbackState,
    migratePageFeedback,
    removePageFeedback,
    saveTurnFeedback,
    undoLastTurn
} = require('../ai-memory');

function save(state, turnId, hashes, timestamp) {
    return saveTurnFeedback(state, {
        turnId: turnId,
        pageHash: 'page',
        scenarioId: 'scenario',
        context: 'Собеседник: проверка',
        blockHashes: hashes,
        embedding: [1, 0],
        updatedAt: timestamp
    });
}

test('all unique clicks in a turn are saved once', function () {
    let state = createFeedbackState();
    state = save(state, 'turn-1', ['a', 'a', 'b'], '2026-01-01T00:00:00.000Z');
    state = save(state, 'turn-1', ['a', 'b'], '2026-01-01T00:00:01.000Z');

    assert.equal(state.examples.length, 2);
    assert.deepEqual(state.examples.map(function (example) { return example.count; }), [1, 1]);
    assert.deepEqual(state.turnLog[0].blockHashes, ['a', 'b']);
});

test('same context and response across turns increments count and undo reverses one turn', function () {
    let state = createFeedbackState();
    state = save(state, 'turn-1', ['a'], '2026-01-01T00:00:00.000Z');
    state = save(state, 'turn-2', ['a'], '2026-01-01T00:01:00.000Z');

    assert.equal(state.examples[0].count, 2);
    state = undoLastTurn(state);
    assert.equal(state.examples[0].count, 1);
    assert.equal(state.turnLog.length, 1);
});

test('feedback can migrate with a renamed page and be removed with it', function () {
    let state = save(createFeedbackState(), 'turn-1', ['a'], '2026-01-01T00:00:00.000Z');
    state = migratePageFeedback(state, 'page', 'renamed');

    assert.equal(state.examples[0].pageHash, 'renamed');
    assert.equal(state.turnLog[0].pageHash, 'renamed');

    state = removePageFeedback(state, 'renamed');
    assert.equal(state.examples.length, 0);
    assert.equal(state.turnLog.length, 0);
});

test('feedback storage keeps at most the configured number of unique pairs', function () {
    let state = createFeedbackState();
    state = saveTurnFeedback(state, {
        turnId: 'turn-1',
        pageHash: 'page',
        scenarioId: 'scenario',
        context: 'контекст',
        blockHashes: ['a', 'b', 'c'],
        embedding: [1],
        updatedAt: '2026-01-01T00:00:00.000Z'
    }, 2);

    assert.equal(state.examples.length, 2);
});

test('feedback is isolated by both character page and prank scenario', function () {
    let state = createFeedbackState();
    state = saveTurnFeedback(state, {
        turnId: 'turn-a',
        pageHash: 'character-a',
        scenarioId: 'scenario-a',
        context: 'одинаковая реплика',
        blockHashes: ['sound'],
        embedding: [1],
        updatedAt: '2026-01-01T00:00:00.000Z'
    });
    state = saveTurnFeedback(state, {
        turnId: 'turn-b',
        pageHash: 'character-a',
        scenarioId: 'scenario-b',
        context: 'одинаковая реплика',
        blockHashes: ['sound'],
        embedding: [1],
        updatedAt: '2026-01-01T00:01:00.000Z'
    });
    state = saveTurnFeedback(state, {
        turnId: 'turn-c',
        pageHash: 'character-b',
        scenarioId: 'scenario-a',
        context: 'одинаковая реплика',
        blockHashes: ['sound'],
        embedding: [1],
        updatedAt: '2026-01-01T00:02:00.000Z'
    });

    assert.equal(state.examples.length, 3);
    assert.equal(new Set(state.examples.map(function (example) { return example.scopeId; })).size, 3);
});
