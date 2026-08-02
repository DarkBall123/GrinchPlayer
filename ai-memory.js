'use strict';

const {normalizeText} = require('./ai-core');

const DEFAULT_LIMIT = 2000;
const TURN_LOG_LIMIT = 100;

function createFeedbackState(state) {
    return {
        examples: state && Array.isArray(state.examples) ? state.examples : [],
        turnLog: state && Array.isArray(state.turnLog) ? state.turnLog : []
    };
}

function exampleKey(scopeId, context, blockHash) {
    return [scopeId, normalizeText(context).toLowerCase(), blockHash].join('\u0000');
}

function feedbackScopeId(pageHash, scenarioId) {
    return [String(pageHash || ''), String(scenarioId || '')].join('\u0000');
}

function saveTurnFeedback(currentState, payload, limit) {
    const state = createFeedbackState(currentState);
    const context = normalizeText(payload.context);
    const uniqueHashes = Array.from(new Set(payload.blockHashes || [])).filter(Boolean);
    const scopeId = payload.scopeId || feedbackScopeId(payload.pageHash, payload.scenarioId);

    if (!payload.turnId || !payload.pageHash || !payload.scenarioId || !context || uniqueHashes.length === 0 ||
        !Array.isArray(payload.embedding)) {
        return state;
    }

    let log = state.turnLog.find(function (item) { return item.turnId === payload.turnId; });
    if (!log) {
        log = {
            turnId: payload.turnId,
            scenarioId: payload.scenarioId || '',
            pageHash: payload.pageHash || '',
            keys: [],
            blockHashes: [],
            embedding: payload.embedding,
            updatedAt: payload.updatedAt
        };
        state.turnLog.push(log);
    }

    uniqueHashes.forEach(function (blockHash) {
        if (log.blockHashes.includes(blockHash)) {
            return;
        }

        const key = exampleKey(scopeId, context, blockHash);
        const existing = state.examples.find(function (example) { return example.id === key; });

        if (existing) {
            existing.count += 1;
            existing.updatedAt = payload.updatedAt;
            existing.embedding = payload.embedding;
            existing.context = context;
        } else {
            state.examples.push({
                id: key,
                scopeId: scopeId,
                scenarioId: payload.scenarioId || '',
                pageHash: payload.pageHash || '',
                blockHash: blockHash,
                context: context,
                embedding: payload.embedding,
                count: 1,
                createdAt: payload.updatedAt,
                updatedAt: payload.updatedAt
            });
        }

        log.keys.push(key);
        log.blockHashes.push(blockHash);
    });

    log.updatedAt = payload.updatedAt;
    state.examples.sort(function (left, right) {
        return String(right.updatedAt).localeCompare(String(left.updatedAt));
    });
    state.examples = state.examples.slice(0, limit || DEFAULT_LIMIT);
    state.turnLog = state.turnLog.slice(-TURN_LOG_LIMIT);

    return state;
}

function undoLastTurn(currentState) {
    const state = createFeedbackState(currentState);
    const log = state.turnLog.pop();

    if (!log) {
        return state;
    }

    log.keys.forEach(function (key) {
        const index = state.examples.findIndex(function (example) { return example.id === key; });
        if (index === -1) {
            return;
        }

        state.examples[index].count -= 1;
        if (state.examples[index].count <= 0) {
            state.examples.splice(index, 1);
        }
    });

    return state;
}

function removePageFeedback(currentState, pageHash) {
    const state = createFeedbackState(currentState);
    state.examples = state.examples.filter(function (example) { return example.pageHash !== pageHash; });
    state.turnLog = state.turnLog.filter(function (turn) { return turn.pageHash !== pageHash; });
    return state;
}

function migratePageFeedback(currentState, oldHash, newHash) {
    const state = createFeedbackState(currentState);
    const migratedKeys = new Map();

    state.examples.forEach(function (example) {
        if (example.pageHash === oldHash) {
            const oldKey = example.id;
            example.pageHash = newHash;
            example.scopeId = feedbackScopeId(newHash, example.scenarioId);
            example.id = exampleKey(example.scopeId, example.context, example.blockHash);
            migratedKeys.set(oldKey, example.id);
        }
    });
    state.turnLog.forEach(function (turn) {
        if (turn.pageHash === oldHash) {
            turn.pageHash = newHash;
            turn.keys = turn.keys.map(function (key) { return migratedKeys.get(key) || key; });
        }
    });

    return state;
}

module.exports = {
    createFeedbackState,
    exampleKey,
    feedbackScopeId,
    migratePageFeedback,
    removePageFeedback,
    saveTurnFeedback,
    undoLastTurn
};
