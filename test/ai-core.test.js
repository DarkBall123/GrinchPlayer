'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    TranscriptTracker,
    advanceCallState,
    buildContextText,
    buildPhraseDescriptor,
    buildScenarioShortlist,
    buildShortlist,
    classifyIncomingUtterance,
    cosineSimilarity,
    historyTurnText,
    inferPhraseMetadata,
    isCurrentRanking,
    parseScenarioPlan,
    rankQuickCandidates,
    rankScenarioCandidates,
    rankSemanticCandidates,
    sanitizeCallState,
    selectDiverseSuggestions,
    selectRelevantHistory,
    sanitizeModelRanking,
    stabilizeSuggestionSlots,
    tacticCompatibility
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

test('context contains six previous exchanges and the current transcript', function () {
    const history = Array.from({length: 12}, function (value, index) {
        return {transcript: 'реплика-' + index, played: [{text: 'ответ-' + index}]};
    });
    const context = buildContextText(history, 'сейчас');

    assert.equal(context.includes('реплика-0\n'), false);
    assert.equal(context.includes('реплика-1\n'), false);
    assert.equal(context.includes('реплика-5\n'), false);
    assert.equal(context.includes('реплика-6'), true);
    assert.equal(context.includes('GrinchPlayer: ответ-11'), true);
    assert.equal(context.endsWith('Собеседник: сейчас'), true);
});

test('shared conversation context identifies which character played each response', function () {
    const text = historyTurnText({
        transcript: 'Кто это говорит?',
        played: [
            {character: 'Банк', text: 'Служба безопасности'},
            {character: 'Полиция', text: 'Откройте дверь'}
        ]
    });

    assert.equal(text.includes('GrinchPlayer (Банк): Служба безопасности'), true);
    assert.equal(text.includes('GrinchPlayer (Полиция): Откройте дверь'), true);
});

test('scenario ranking stays inside the supplied character page without penalizing deliberate repeats', function () {
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
    }, 'page\u0000scenario', {
        incoming: classifyIncomingUtterance('Что вы хотите?'),
        recentHashes: ['recent']
    }, 3);

    assert.equal(ranked[0].hash, 'current');
    assert.equal(ranked.find(function (item) { return item.hash === 'recent'; }).recentlyPlayed, true);
    assert.equal(ranked.find(function (item) { return item.hash === 'recent'; }).score, ranked[0].score);
    assert.equal(ranked.some(function (item) { return item.hash === 'other-page'; }), false);
});

test('explicit scenario facts boost matching recorded phrases over contradictions', function () {
    const candidates = [
        {hash: 'fact', text: 'Это Бутусово'},
        {hash: 'contradiction', text: 'Из Борисовки'}
    ];
    const entries = {
        fact: {embedding: [1, 0], metadata: inferPhraseMetadata('Это Бутусово')},
        contradiction: {embedding: [1, 0], metadata: inferPhraseMetadata('Из Борисовки')}
    };
    const ranked = rankScenarioCandidates(candidates, entries, [], {
        current: [1, 0],
        scenario: [1, 0],
        feedback: [1, 0]
    }, 'page\u0000scenario', {
        incoming: classifyIncomingUtterance('Откуда вы?'),
        recentHashes: [],
        scenarioText: 'Факт: Сурель живёт в Бутусово'
    }, 2);

    assert.deepEqual(ranked.map(function (item) { return item.hash; }), ['fact', 'contradiction']);
    assert.equal(ranked[0].scenarioLexicalScore, 1);
    assert.equal(ranked[1].scenarioLexicalScore, 0);
});

test('quick fallback returns relevant existing phrases without waiting for embeddings', function () {
    const candidates = [
        {hash: 'identity', text: 'Ну я Любовь Сурель'},
        {hash: 'right-place', text: 'Это Бутусово'},
        {hash: 'wrong-place', text: 'Из Борисовки'},
        {hash: 'television', text: 'Смотрю телевизор'},
        {hash: 'repair', text: 'Ничего не понимаю'},
        {hash: 'counter', text: 'А вам кого нужно'}
    ];
    const scenario = 'Роль: Любовь Сурель. Факты: живёт в Бутусово.';

    const identity = rankQuickCandidates(candidates, 'Кто это говорит?', scenario, {}, 5);
    const location = rankQuickCandidates(candidates, 'Откуда вы?', scenario, {}, 5);
    const activity = rankQuickCandidates(candidates, 'Что вы сейчас делаете?', scenario, {}, 5);

    assert.equal(identity[0].hash, 'identity');
    assert.equal(location[0].hash, 'right-place');
    assert.equal(location.findIndex(function (item) { return item.hash === 'right-place'; }) <
        location.findIndex(function (item) { return item.hash === 'wrong-place'; }), true);
    assert.equal(activity[0].hash, 'television');
    assert.equal(identity.every(function (item) { return candidates.some(function (candidate) {
        return candidate.hash === item.hash;
    }); }), true);
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
    const shortlist = buildScenarioShortlist(
        ranked,
        candidates,
        [{blockHash: 'learned'}],
        classifyIncomingUtterance('Что случилось?'),
        40
    );

    assert.deepEqual(shortlist.map(function (item) { return item.hash; }), ['speech', 'plan', 'learned']);
});

test('Russian phrase metadata distinguishes repair, denial, counter-question and escalation', function () {
    assert.equal(inferPhraseMetadata('Я вас не слышу, повторите').dialogueAct, 'repair');
    assert.equal(inferPhraseMetadata('Нет, вы ошиблись номером').dialogueAct, 'denial');
    assert.equal(inferPhraseMetadata('А вам кого нужно').dialogueAct, 'counter_question');
    assert.equal(inferPhraseMetadata('Я вызову полицию').dialogueAct, 'escalation');
    assert.equal(inferPhraseMetadata('Ну я Любовь Сурель').dialogueAct, 'answer');
    assert.equal(inferPhraseMetadata('А я Сурель Любовь').dialogueAct, 'answer');
    assert.equal(inferPhraseMetadata('А я Сурель Любовь').topics.includes('identity'), true);
    assert.equal(inferPhraseMetadata('Люба это').dialogueAct, 'answer');
    assert.equal(inferPhraseMetadata('Это Бутусово').dialogueAct, 'answer');
    assert.equal(inferPhraseMetadata('Вы не туда попали').dialogueAct, 'denial');
    assert.equal(inferPhraseMetadata('Спасибо за поздравление').dialogueAct, 'answer');
    assert.equal(classifyIncomingUtterance('Кто это говорит?').act, 'identity_question');
    assert.equal(classifyIncomingUtterance('Алло, кто это говорит?').act, 'identity_question');
    assert.equal(classifyIncomingUtterance('Плохо слышно, повторите').act, 'connection_problem');
    assert.equal(classifyIncomingUtterance('Ты идиот').act, 'insult');
    assert.deepEqual(classifyIncomingUtterance('Откуда вы?').topics, ['location']);
    assert.deepEqual(classifyIncomingUtterance('Что вы сейчас делаете?').topics, ['activity']);
    assert.equal(classifyIncomingUtterance('С Новым годом!').topics.includes('location'), false);
    assert.equal(classifyIncomingUtterance('Я Юра, вы меня знаете?').topics.includes('acquaintance'), true);
    assert.equal(inferPhraseMetadata('Нет уж я не приду к вам').topics.includes('visit'), true);
    assert.equal(
        tacticCompatibility(
            classifyIncomingUtterance('Откуда вы?'),
            inferPhraseMetadata('Это Бутусово')
        ) > tacticCompatibility(
            classifyIncomingUtterance('Откуда вы?'),
            inferPhraseMetadata('Да нет')
        ),
        true
    );
    assert.equal(classifyIncomingUtterance('Вы ошиблись номером').act, 'accusation');
    assert.equal(classifyIncomingUtterance('Вы ошиблись номером').topics.includes('wrong_number'), true);
});

test('phrase descriptor enriches the original label without changing it', function () {
    const descriptor = buildPhraseDescriptor({text: 'Я вас не слышу, повторите'});
    assert.equal(descriptor.includes('Записанная реплика: Я вас не слышу, повторите'), true);
    assert.equal(descriptor.includes('Речевой акт и тактика: repair; repair'), true);
});

test('provisional top-k keeps useful tactics diverse without forcing weak candidates', function () {
    const ranked = [
        {hash: 'direct', score: 1, tactics: ['direct'], tactic: 'direct'},
        {hash: 'counter', score: 0.96, tactics: ['counter'], tactic: 'counter'},
        {hash: 'repair', score: 0.9, tactics: ['repair'], tactic: 'repair'},
        {hash: 'scenario', score: 0.88, tactics: ['scenario'], tactic: 'scenario'},
        {hash: 'escalation', score: 0.84, tactics: ['escalation'], tactic: 'escalation'},
        {hash: 'weak-exit', score: 0.1, tactics: ['exit'], tactic: 'exit'}
    ];
    const selected = selectDiverseSuggestions(ranked, classifyIncomingUtterance('Кто это?'), 5);

    assert.deepEqual(selected.map(function (item) { return item.hash; }), [
        'direct', 'counter', 'repair', 'scenario', 'escalation'
    ]);
    assert.equal(selected.some(function (item) { return item.hash === 'weak-exit'; }), false);
});

test('call state is bounded and advances from the exact interlocutor turn', function () {
    const state = advanceCallState({
        phase: 'opening',
        establishedFacts: Array.from({length: 12}, function (value, index) { return 'факт-' + index; })
    }, 'Кто это говорит?');
    const sanitized = sanitizeCallState(Object.assign({}, state, {emotion: 'invented'}));

    assert.equal(state.phase, 'engagement');
    assert.equal(state.lastInterlocutorAct, 'identity_question');
    assert.equal(state.unresolvedQuestions.includes('Кто это говорит?'), true);
    assert.equal(sanitized.establishedFacts.length, 8);
    assert.equal(sanitized.emotion, 'neutral');
});

test('scenario prompt is parsed as a call map while legacy notes remain valid', function () {
    const plan = parseScenarioPlan('Легенда: Сурель Любовь\nЦель: удержать разговор\nФакты:\n- живёт в Бутусово\nЭтапы:\n1. знакомство\n2. спор\nНельзя:\n- менять имя');
    const legacy = parseScenarioPlan('Вальяжная дерзкая бабушка с плохой памятью');

    assert.equal(plan.legend, 'Сурель Любовь');
    assert.deepEqual(plan.stages, ['знакомство', 'спор']);
    assert.deepEqual(plan.forbidden, ['менять имя']);
    assert.equal(legacy.notes, 'Вальяжная дерзкая бабушка с плохой памятью');
});

test('stable slots keep surviving suggestions under the same hotkeys', function () {
    const previous = ['a', 'b', 'c', 'd', 'e'].map(function (hash) { return {hash: hash}; });
    const incoming = ['c', 'x', 'a', 'e', 'y'].map(function (hash) { return {hash: hash}; });
    assert.deepEqual(stabilizeSuggestionSlots(previous, incoming, 5).map(function (item) { return item.hash; }), [
        'a', 'x', 'c', 'y', 'e'
    ]);
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
