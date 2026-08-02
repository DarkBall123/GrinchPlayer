'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    TranscriptTracker,
    buildContextText,
    buildScenarioShortlist,
    buildShortlist,
    cosineSimilarity,
    isCurrentRanking,
    rankScenarioCandidates,
    rankSemanticCandidates,
    selectRelevantHistory,
    sanitizeModelRanking
} = require('../ai-core');

test('cosine similarity handles matching, orthogonal and invalid vectors', function () {
    assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
    assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
    assert.equal(cosineSimilarity([1], [1, 0]), 0);
    assert.equal(cosineSimilarity([], []), 0);
});

test('semantic ranking combines label and learned preference similarity', function () {
    const candidates = [
        {hash: 'label', text: 'По смыслу'},
        {hash: 'learned', text: 'По привычке'}
    ];
    const entries = {
        label: {embedding: [1, 0]},
        learned: {embedding: [0.7, 0.7]}
    };
    const examples = [{pageHash: 'page', blockHash: 'learned', embedding: [1, 0]}];
    const ranked = rankSemanticCandidates(candidates, entries, examples, [1, 0], 'page', 2);

    assert.equal(ranked[0].hash, 'learned');
    assert.equal(ranked[0].feedbackScore, 1);
});

test('shortlist includes learned clips and model ranking is constrained to it', function () {
    const candidates = [
        {hash: 'a', text: 'A'},
        {hash: 'b', text: 'B'},
        {hash: 'learned', text: 'Learned'}
    ];
    const semantic = [
        {hash: 'a', text: 'A'},
        {hash: 'b', text: 'B'}
    ];
    const shortlist = buildShortlist(semantic, candidates, [{blockHash: 'learned'}], 30);
    const ids = sanitizeModelRanking(['missing', 'learned', 'learned'], shortlist, semantic, 3);

    assert.deepEqual(shortlist.map(function (item) { return item.hash; }), ['a', 'b', 'learned']);
    assert.deepEqual(ids, ['learned', 'a', 'b']);
});

test('context contains ten previous exchanges and the current transcript', function () {
    const history = Array.from({length: 12}, function (value, index) {
        return {transcript: 'реплика-' + index, played: [{text: 'ответ-' + index}]};
    });
    const context = buildContextText(history, 'сейчас');

    assert.equal(context.includes('реплика-0\n'), false);
    assert.equal(context.includes('реплика-1\n'), false);
    assert.equal(context.includes('реплика-2'), true);
    assert.equal(context.includes('GrinchPlayer: ответ-11'), true);
    assert.equal(context.endsWith('Собеседник: сейчас'), true);
});

test('scenario ranking stays inside the supplied character page and penalizes recent sounds', function () {
    const candidates = [
        {hash: 'current', text: 'Ответ сейчас'},
        {hash: 'scenario', text: 'Ответ по плану'},
        {hash: 'recent', text: 'Недавний ответ'}
    ];
    const entries = {
        current: {embedding: [1, 0]},
        scenario: {embedding: [0, 1]},
        recent: {embedding: [1, 0]},
        'other-page': {embedding: [1, 0]}
    };
    const examples = [{scopeId: 'page\u0000scenario', blockHash: 'scenario', embedding: [1, 1]}];
    const ranked = rankScenarioCandidates(candidates, entries, examples, {
        current: [1, 0],
        scenario: [0, 1],
        feedback: [1, 1]
    }, 'page\u0000scenario', ['recent'], 3);

    assert.equal(ranked[0].hash, 'current');
    assert.equal(ranked.find(function (item) { return item.hash === 'recent'; }).repetitionPenalty, 0.25);
    assert.equal(ranked.find(function (item) { return item.hash === 'recent'; }).score < ranked[0].score, true);
    assert.equal(ranked.some(function (item) { return item.hash === 'other-page'; }), false);
});

test('scenario shortlist includes candidates selected by current speech, plan and learned clicks', function () {
    const candidates = [
        {hash: 'speech', text: 'По реплике'},
        {hash: 'plan', text: 'По сценарию'},
        {hash: 'learned', text: 'По кликам'}
    ];
    const ranked = [
        {hash: 'speech', text: 'По реплике', currentScore: 1, scenarioScore: 0},
        {hash: 'plan', text: 'По сценарию', currentScore: 0, scenarioScore: 1}
    ];
    const shortlist = buildScenarioShortlist(ranked, candidates, [{blockHash: 'learned'}], 40);

    assert.deepEqual(shortlist.map(function (item) { return item.hash; }), ['speech', 'plan', 'learned']);
});

test('relevant old exchanges are selected by current speech and scenario', function () {
    const history = [
        {turnId: 'old-current', transcript: 'возврат к вопросу'},
        {turnId: 'old-plan', transcript: 'этап сценария'},
        {turnId: 'noise', transcript: 'не связано'}
    ];
    const selected = selectRelevantHistory(history, new Map([
        ['old-current', [1, 0]],
        ['old-plan', [0, 1]],
        ['noise', [-1, 0]]
    ]), [1, 0], [0, 1], 2);

    assert.deepEqual(selected.map(function (turn) { return turn.turnId; }), ['old-current', 'old-plan']);
});

test('transcription events are matched by item id even when completions arrive out of order', function () {
    const tracker = new TranscriptTracker();
    tracker.handle({type: 'speech_started', itemId: 'first', timestamp: 1});
    tracker.handle({type: 'speech_started', itemId: 'second', timestamp: 2});
    tracker.handle({type: 'transcript_completed', itemId: 'second', transcript: 'два'});
    tracker.handle({type: 'transcript_completed', itemId: 'first', transcript: 'один'});

    assert.equal(tracker.turns.get('first').transcript, 'один');
    assert.equal(tracker.turns.get('second').transcript, 'два');
});

test('stale ranking metadata is rejected', function () {
    const expected = {turnId: 'turn-2', pageHash: 'page', revision: 4};
    assert.equal(isCurrentRanking({turnId: 'turn-2', pageHash: 'page', revision: 4}, expected), true);
    assert.equal(isCurrentRanking({turnId: 'turn-1', pageHash: 'page', revision: 4}, expected), false);
    assert.equal(isCurrentRanking({turnId: 'turn-2', pageHash: 'other', revision: 4}, expected), false);
    assert.equal(isCurrentRanking({turnId: 'turn-2', pageHash: 'page', revision: 3}, expected), false);
});
