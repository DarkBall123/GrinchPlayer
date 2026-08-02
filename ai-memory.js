'use strict';

const {normalizeText, sanitizeCallState} = require('./ai-core');

const DEFAULT_LIMIT = 2000;
const TURN_LOG_LIMIT = 500;
const OBSERVATION_LIMIT = 1000;

function createFeedbackState(state) {
    return {
        examples: state && Array.isArray(state.examples) ? state.examples : [],
        turnLog: state && Array.isArray(state.turnLog) ? state.turnLog : [],
        observations: state && Array.isArray(state.observations) ? state.observations : []
    };
}

function exampleKey(scopeId, context, blockHash) {
    return [scopeId, normalizeText(context).toLowerCase(), blockHash].join('\u0000');
}

function feedbackScopeId(pageHash, scenarioId) {
    return [String(pageHash || ''), String(scenarioId || '')].join('\u0000');
}

function boundedNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.min(number, 3600000)) : null;
}

function normalizeSelection(selection, fallbackPageHash) {
    const source = selection && typeof selection === 'object' ? selection : {blockHash: selection};
    const outsideTopK = source.outsideTopK === true ? true : source.outsideTopK === false ? false : null;
    return {
        blockHash: String(source.blockHash || source.hash || ''),
        pageHash: String(source.pageHash || fallbackPageHash || ''),
        suggestedIds: Array.from(new Set(Array.isArray(source.suggestedIds) ? source.suggestedIds : []))
            .map(String).filter(Boolean).slice(0, 5),
        outsideTopK: outsideTopK,
        clickedAt: String(source.clickedAt || ''),
        clickLatencyMs: boundedNumber(source.clickLatencyMs),
        postSpeechLatencyMs: boundedNumber(source.postSpeechLatencyMs),
        suggestionLatencyMs: boundedNumber(source.suggestionLatencyMs),
        character: normalizeText(source.character).slice(0, 100),
        source: normalizeText(source.source).slice(0, 30),
        final: Boolean(source.final),
        repeatCount: Math.max(1, Math.min(Number(source.repeatCount) || 1, 100)),
        callState: sanitizeCallState(source.callState)
    };
}

function normalizeSelections(payload) {
    const source = Array.isArray(payload.selections) ? payload.selections :
        (Array.isArray(payload.blockHashes) ? payload.blockHashes : []);
    const seen = new Set();
    return source.map(function (selection) { return normalizeSelection(selection, payload.pageHash); })
        .filter(function (selection) {
            if (!selection.blockHash || seen.has(selection.blockHash)) {
                return false;
            }
            seen.add(selection.blockHash);
            return true;
        });
}

function cloneExample(example) {
    return example ? JSON.parse(JSON.stringify(example)) : null;
}

function saveTurnFeedback(currentState, payload, limit) {
    const state = createFeedbackState(currentState);
    const context = normalizeText(payload.context);
    const selections = normalizeSelections(payload);
    const scopeId = payload.scopeId || feedbackScopeId(payload.pageHash, payload.scenarioId);

    if (!payload.turnId || !payload.pageHash || !payload.scenarioId || !context || selections.length === 0 ||
        !Array.isArray(payload.embedding)) {
        return state;
    }

    let log = state.turnLog.find(function (item) { return item.turnId === payload.turnId; });
    if (!log) {
        log = {
            turnId: payload.turnId,
            rootTurnId: payload.rootTurnId || payload.turnId,
            scenarioId: payload.scenarioId || '',
            pageHash: payload.pageHash || '',
            keys: [],
            blockHashes: [],
            selections: [],
            previousExamples: {},
            embedding: payload.embedding,
            startedAt: String(payload.startedAt || payload.updatedAt || ''),
            updatedAt: payload.updatedAt
        };
        state.turnLog.push(log);
    }
    log.selections = Array.isArray(log.selections) ? log.selections : [];
    log.previousExamples = log.previousExamples && !Array.isArray(log.previousExamples) ?
        log.previousExamples : {};
    if (payload.startedAt) {
        log.startedAt = String(payload.startedAt);
    }

    selections.forEach(function (selection) {
        const blockHash = selection.blockHash;
        const key = exampleKey(scopeId, context, blockHash);
        const existing = state.examples.find(function (example) { return example.id === key; });
        const loggedIndex = log.blockHashes.indexOf(blockHash);
        if (loggedIndex !== -1) {
            if (!existing) {
                return;
            }
            const previousSelection = normalizeSelection(log.selections[loggedIndex], payload.pageHash);
            const signalStrength = function (value) {
                return value === true ? 2 : value === false ? 1 : 0;
            };
            if (signalStrength(selection.outsideTopK) < signalStrength(previousSelection.outsideTopK)) {
                return;
            }
            if (previousSelection.outsideTopK === true) {
                existing.outsideTopKCount = Math.max(0, (existing.outsideTopKCount || 0) - 1);
            } else if (previousSelection.outsideTopK === false) {
                existing.shownSelectionCount = Math.max(0, (existing.shownSelectionCount || 0) - 1);
            }
            if (selection.outsideTopK === true) {
                existing.outsideTopKCount = (existing.outsideTopKCount || 0) + 1;
            } else if (selection.outsideTopK === false) {
                existing.shownSelectionCount = (existing.shownSelectionCount || 0) + 1;
            }
            existing.updatedAt = payload.updatedAt;
            existing.embedding = payload.embedding;
            existing.lastSuggestedIds = selection.suggestedIds;
            existing.lastClickLatencyMs = selection.clickLatencyMs;
            existing.lastCallState = selection.callState;
            existing.lastRepeatCount = selection.repeatCount;
            log.selections[loggedIndex] = selection;
            return;
        }

        const previousExample = cloneExample(existing);

        if (existing) {
            existing.count += 1;
            existing.updatedAt = payload.updatedAt;
            existing.embedding = payload.embedding;
            existing.context = context;
            existing.outsideTopKCount = (existing.outsideTopKCount || 0) +
                (selection.outsideTopK === true ? 1 : 0);
            existing.shownSelectionCount = (existing.shownSelectionCount || 0) +
                (selection.outsideTopK === false ? 1 : 0);
            existing.lastSuggestedIds = selection.suggestedIds;
            existing.lastClickLatencyMs = selection.clickLatencyMs;
            existing.lastCallState = selection.callState;
            existing.lastRepeatCount = selection.repeatCount;
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
                outsideTopKCount: selection.outsideTopK === true ? 1 : 0,
                shownSelectionCount: selection.outsideTopK === false ? 1 : 0,
                lastSuggestedIds: selection.suggestedIds,
                lastClickLatencyMs: selection.clickLatencyMs,
                lastCallState: selection.callState,
                lastRepeatCount: selection.repeatCount,
                nextTranscript: normalizeText(payload.nextTranscript),
                createdAt: payload.updatedAt,
                updatedAt: payload.updatedAt
            });
        }

        log.keys.push(key);
        log.blockHashes.push(blockHash);
        log.selections.push(selection);
        log.previousExamples[key] = previousExample;
    });

    log.updatedAt = payload.updatedAt;
    state.examples.sort(function (left, right) {
        return String(right.updatedAt).localeCompare(String(left.updatedAt));
    });
    state.examples = state.examples.slice(0, limit || DEFAULT_LIMIT);
    state.turnLog = state.turnLog.slice(-TURN_LOG_LIMIT);

    return state;
}

function normalizeSnapshot(snapshot) {
    const source = snapshot || {};
    return {
        pageHash: String(source.pageHash || ''),
        ids: Array.from(new Set(Array.isArray(source.ids) ? source.ids : [])).map(String).filter(Boolean).slice(0, 5),
        source: normalizeText(source.source).slice(0, 30),
        final: Boolean(source.final),
        visible: Boolean(source.visible),
        shownAt: String(source.shownAt || ''),
        revision: Number.isFinite(Number(source.revision)) ? Number(source.revision) : 0,
        callState: sanitizeCallState(source.callState)
    };
}

function saveTurnObservation(currentState, payload) {
    const state = createFeedbackState(currentState);
    const turnId = String(payload.turnId || '');
    const rootTurnId = String(payload.rootTurnId || turnId);
    const pageHash = String(payload.pageHash || '');
    const scenarioId = String(payload.scenarioId || '');
    const transcript = normalizeText(payload.transcript);
    if (!turnId || !rootTurnId || !pageHash || !scenarioId || !transcript) {
        return state;
    }

    const id = rootTurnId + '\u0000' + pageHash;
    const observation = {
        id: id,
        turnId: turnId,
        rootTurnId: rootTurnId,
        scenarioId: scenarioId,
        pageHash: pageHash,
        transcript: transcript,
        context: normalizeText(payload.context),
        startedAt: String(payload.startedAt || ''),
        completedAt: String(payload.completedAt || ''),
        updatedAt: String(payload.updatedAt || ''),
        callState: sanitizeCallState(payload.callState),
        suggestionSnapshots: (Array.isArray(payload.suggestionSnapshots) ? payload.suggestionSnapshots : [])
            .map(normalizeSnapshot).filter(function (snapshot) { return snapshot.pageHash === pageHash; }).slice(-3),
        selections: normalizeSelections(payload).filter(function (selection) {
            return !selection.pageHash || selection.pageHash === pageHash;
        }),
        nextTranscript: normalizeText(payload.nextTranscript)
    };
    const index = state.observations.findIndex(function (item) { return item.id === id; });
    if (index === -1) {
        state.observations.push(observation);
    } else {
        observation.nextTranscript = observation.nextTranscript || state.observations[index].nextTranscript || '';
        state.observations[index] = observation;
    }
    state.observations = state.observations.slice(-OBSERVATION_LIMIT);
    return state;
}

function attachNextTranscript(currentState, rootTurnId, transcript) {
    const state = createFeedbackState(currentState);
    const nextTranscript = normalizeText(transcript);
    if (!rootTurnId || !nextTranscript) {
        return state;
    }

    state.observations.forEach(function (observation) {
        if ((observation.rootTurnId || observation.turnId) === rootTurnId) {
            observation.nextTranscript = nextTranscript;
        }
    });
    state.turnLog.forEach(function (log) {
        if ((log.rootTurnId || log.turnId) !== rootTurnId) {
            return;
        }
        log.keys.forEach(function (key) {
            const example = state.examples.find(function (item) { return item.id === key; });
            if (example) {
                example.nextTranscript = nextTranscript;
            }
        });
    });
    return state;
}

function undoLastTurn(currentState) {
    const state = createFeedbackState(currentState);
    if (state.turnLog.length === 0) {
        return state;
    }

    const roots = new Map();
    state.turnLog.forEach(function (log, index) {
        const rootTurnId = log.rootTurnId || log.turnId;
        const timestamp = Date.parse(log.startedAt || log.updatedAt || '');
        const chronology = Number.isFinite(timestamp) ? timestamp : index;
        const current = roots.get(rootTurnId);
        if (!current || chronology > current.chronology ||
            (chronology === current.chronology && index > current.index)) {
            roots.set(rootTurnId, {chronology: chronology, index: index});
        }
    });
    let rootTurnId = '';
    let latest = null;
    roots.forEach(function (entry, candidateRootTurnId) {
        if (!latest || entry.chronology > latest.chronology ||
            (entry.chronology === latest.chronology && entry.index > latest.index)) {
            rootTurnId = candidateRootTurnId;
            latest = entry;
        }
    });
    const logs = state.turnLog.filter(function (log) {
        return (log.rootTurnId || log.turnId) === rootTurnId;
    });
    state.turnLog = state.turnLog.filter(function (log) {
        return (log.rootTurnId || log.turnId) !== rootTurnId;
    });

    logs.forEach(function (log) {
        (log.keys || []).forEach(function (key, selectionIndex) {
            const index = state.examples.findIndex(function (example) { return example.id === key; });
            const hasSnapshot = log.previousExamples &&
                Object.prototype.hasOwnProperty.call(log.previousExamples, key);
            if (hasSnapshot) {
                const previousExample = cloneExample(log.previousExamples[key]);
                if (previousExample) {
                    if (index === -1) {
                        state.examples.push(previousExample);
                    } else {
                        state.examples[index] = previousExample;
                    }
                } else if (index !== -1) {
                    state.examples.splice(index, 1);
                }
                return;
            }
            if (index === -1) {
                return;
            }

            const selection = Array.isArray(log.selections) ? log.selections[selectionIndex] : null;
            state.examples[index].count -= 1;
            if (selection && selection.outsideTopK === true) {
                state.examples[index].outsideTopKCount = Math.max(0,
                    (state.examples[index].outsideTopKCount || 0) - 1);
            }
            if (selection && selection.outsideTopK === false) {
                state.examples[index].shownSelectionCount = Math.max(0,
                    (state.examples[index].shownSelectionCount || 0) - 1);
            }
            if (state.examples[index].count <= 0) {
                state.examples.splice(index, 1);
            }
        });
    });
    state.examples.sort(function (left, right) {
        return String(right.updatedAt).localeCompare(String(left.updatedAt));
    });
    state.observations = state.observations.filter(function (observation) {
        return (observation.rootTurnId || observation.turnId) !== rootTurnId;
    });
    state.rootTurnId = rootTurnId;

    return state;
}

function removePageFeedback(currentState, pageHash) {
    const state = createFeedbackState(currentState);
    state.examples = state.examples.filter(function (example) { return example.pageHash !== pageHash; });
    state.turnLog = state.turnLog.filter(function (turn) { return turn.pageHash !== pageHash; });
    state.observations = state.observations.filter(function (observation) { return observation.pageHash !== pageHash; });
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
            if (turn.turnId.endsWith('\u0000' + oldHash)) {
                turn.turnId = turn.turnId.slice(0, -oldHash.length) + newHash;
            }
            turn.keys = turn.keys.map(function (key) { return migratedKeys.get(key) || key; });
            if (turn.previousExamples && !Array.isArray(turn.previousExamples)) {
                const previousExamples = {};
                Object.keys(turn.previousExamples).forEach(function (key) {
                    const migratedKey = migratedKeys.get(key) || key;
                    const snapshot = cloneExample(turn.previousExamples[key]);
                    if (snapshot && snapshot.pageHash === oldHash) {
                        snapshot.pageHash = newHash;
                        snapshot.scopeId = feedbackScopeId(newHash, snapshot.scenarioId);
                        snapshot.id = exampleKey(snapshot.scopeId, snapshot.context, snapshot.blockHash);
                    }
                    previousExamples[migratedKey] = snapshot;
                });
                turn.previousExamples = previousExamples;
            }
            if (Array.isArray(turn.selections)) {
                turn.selections.forEach(function (selection) { selection.pageHash = newHash; });
            }
        }
    });
    state.observations.forEach(function (observation) {
        if (observation.pageHash === oldHash) {
            observation.pageHash = newHash;
            observation.id = (observation.rootTurnId || observation.turnId) + '\u0000' + newHash;
            (observation.suggestionSnapshots || []).forEach(function (snapshot) { snapshot.pageHash = newHash; });
            (observation.selections || []).forEach(function (selection) { selection.pageHash = newHash; });
        }
    });

    return state;
}

module.exports = {
    attachNextTranscript,
    createFeedbackState,
    exampleKey,
    feedbackScopeId,
    migratePageFeedback,
    normalizeSelection,
    removePageFeedback,
    saveTurnFeedback,
    saveTurnObservation,
    undoLastTurn
};
