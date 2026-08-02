'use strict';

const DEFAULT_TOP_K = 5;
const DEFAULT_HISTORY_LIMIT = 10;
const DEFAULT_HISTORY_CHARS = 8000;

function normalizeText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
}

function cosineSimilarity(left, right) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length === 0 || left.length !== right.length) {
        return 0;
    }

    let dot = 0;
    let leftNorm = 0;
    let rightNorm = 0;

    for (let i = 0; i < left.length; i++) {
        dot += left[i] * right[i];
        leftNorm += left[i] * left[i];
        rightNorm += right[i] * right[i];
    }

    if (leftNorm === 0 || rightNorm === 0) {
        return 0;
    }

    return dot / Math.sqrt(leftNorm * rightNorm);
}

function historyTurnText(turn) {
    const lines = [];
    const transcript = normalizeText(turn && turn.transcript);
    if (transcript) {
        lines.push('Собеседник: ' + transcript);
    }

    const played = turn && Array.isArray(turn.played) ? turn.played : [];
    played.forEach(function (item) {
        const text = normalizeText(item && typeof item === 'object' ? item.text : item);
        if (!text) {
            return;
        }

        const character = normalizeText(item && typeof item === 'object' ? item.character : '');
        lines.push('GrinchPlayer' + (character ? ' (' + character + ')' : '') + ': ' + text);
    });

    return lines.join('\n');
}

function selectRecentHistory(history, limit, maxChars) {
    const source = Array.isArray(history) ? history : [];
    const maxTurns = limit || DEFAULT_HISTORY_LIMIT;
    const charLimit = maxChars || DEFAULT_HISTORY_CHARS;
    const selected = [];
    let usedChars = 0;

    for (let index = source.length - 1; index >= 0 && selected.length < maxTurns; index--) {
        const text = historyTurnText(source[index]);
        if (!text) {
            continue;
        }
        if (selected.length > 0 && usedChars + text.length > charLimit) {
            break;
        }

        selected.unshift(source[index]);
        usedChars += text.length;
    }

    return selected;
}

function buildContextText(history, transcript, options) {
    const settings = options || {};
    const lines = selectRecentHistory(history, settings.limit, settings.maxChars)
        .map(historyTurnText)
        .filter(Boolean);

    const currentTranscript = normalizeText(transcript);
    if (currentTranscript) {
        lines.push('Собеседник: ' + currentTranscript);
    }

    return lines.join('\n');
}

function nearestExamples(examples, queryEmbedding, pageHash, limit) {
    return (Array.isArray(examples) ? examples : [])
        .filter(function (example) {
            return (example.scopeId || example.pageHash) === pageHash && Array.isArray(example.embedding);
        })
        .map(function (example) {
            return Object.assign({}, example, {
                similarity: cosineSimilarity(queryEmbedding, example.embedding)
            });
        })
        .sort(function (left, right) {
            return right.similarity - left.similarity;
        })
        .slice(0, limit);
}

function rankScenarioCandidates(candidates, indexEntries, examples, embeddings, scenarioId, recentHashes, topK) {
    const exampleScores = {};
    const feedbackEmbedding = embeddings.feedback || embeddings.current;

    nearestExamples(examples, feedbackEmbedding, scenarioId, examples.length).forEach(function (example) {
        const score = Math.max(0, example.similarity);
        exampleScores[example.blockHash] = Math.max(exampleScores[example.blockHash] || 0, score);
    });

    const recent = new Set(Array.isArray(recentHashes) ? recentHashes : []);
    return (Array.isArray(candidates) ? candidates : [])
        .map(function (candidate) {
            const entry = indexEntries[candidate.hash];
            if (!entry || !Array.isArray(entry.embedding)) {
                return null;
            }

            const currentScore = cosineSimilarity(embeddings.current, entry.embedding);
            const scenarioScore = Array.isArray(embeddings.scenario) ?
                cosineSimilarity(embeddings.scenario, entry.embedding) : 0;
            const feedbackScore = exampleScores[candidate.hash] || 0;
            const repetitionPenalty = recent.has(candidate.hash) ? 0.25 : 0;

            return Object.assign({}, candidate, {
                score: (0.6 * currentScore) + (0.25 * scenarioScore) + (0.15 * feedbackScore) -
                    repetitionPenalty,
                currentScore: currentScore,
                scenarioScore: scenarioScore,
                feedbackScore: feedbackScore,
                repetitionPenalty: repetitionPenalty
            });
        })
        .filter(Boolean)
        .sort(function (left, right) {
            if (right.score === left.score) {
                return left.hash.localeCompare(right.hash);
            }
            return right.score - left.score;
        })
        .slice(0, topK || DEFAULT_TOP_K);
}

function buildScenarioShortlist(ranked, candidates, nearest, limit) {
    const maxItems = limit || 40;
    const byHash = {};
    const result = [];

    candidates.forEach(function (candidate) { byHash[candidate.hash] = candidate; });

    function append(candidate) {
        if (candidate && !result.some(function (item) { return item.hash === candidate.hash; })) {
            result.push(Object.assign({}, byHash[candidate.hash] || candidate));
        }
    }

    ranked.slice().sort(function (left, right) { return right.currentScore - left.currentScore; })
        .slice(0, 20).forEach(append);
    ranked.slice().sort(function (left, right) { return right.scenarioScore - left.scenarioScore; })
        .slice(0, 10).forEach(append);
    nearest.slice(0, 10).forEach(function (example) { append(byHash[example.blockHash]); });
    ranked.forEach(append);

    return result.slice(0, maxItems);
}

function selectRelevantHistory(history, embeddings, currentEmbedding, scenarioEmbedding, limit) {
    const byTurn = embeddings instanceof Map ? embeddings : new Map(Object.entries(embeddings || {}));
    return (Array.isArray(history) ? history : [])
        .map(function (turn) {
            const embedding = byTurn.get(turn.turnId);
            if (!Array.isArray(embedding)) {
                return null;
            }

            const currentScore = cosineSimilarity(currentEmbedding, embedding);
            const scenarioScore = Array.isArray(scenarioEmbedding) ? cosineSimilarity(scenarioEmbedding, embedding) : 0;
            return {turn: turn, score: (0.75 * currentScore) + (0.25 * scenarioScore)};
        })
        .filter(Boolean)
        .sort(function (left, right) { return right.score - left.score; })
        .slice(0, limit || 3)
        .map(function (item) { return item.turn; });
}

function rankSemanticCandidates(candidates, indexEntries, examples, queryEmbedding, pageHash, topK) {
    const exampleScores = {};
    const feedbackExamples = Array.isArray(examples) ? examples : [];

    nearestExamples(feedbackExamples, queryEmbedding, pageHash, feedbackExamples.length).forEach(function (example) {
        const score = Math.max(0, example.similarity);
        exampleScores[example.blockHash] = Math.max(exampleScores[example.blockHash] || 0, score);
    });

    return (Array.isArray(candidates) ? candidates : [])
        .map(function (candidate) {
            const entry = indexEntries[candidate.hash];
            if (!entry || !Array.isArray(entry.embedding)) {
                return null;
            }

            const labelScore = cosineSimilarity(queryEmbedding, entry.embedding);
            const feedbackScore = exampleScores[candidate.hash] || 0;

            return {
                hash: candidate.hash,
                text: candidate.text,
                score: (0.65 * labelScore) + (0.35 * feedbackScore),
                labelScore: labelScore,
                feedbackScore: feedbackScore
            };
        })
        .filter(Boolean)
        .sort(function (left, right) {
            if (right.score === left.score) {
                return left.hash.localeCompare(right.hash);
            }

            return right.score - left.score;
        })
        .slice(0, topK || DEFAULT_TOP_K);
}

function buildShortlist(semanticResults, candidates, nearest, limit) {
    const byHash = {};
    const result = [];

    candidates.forEach(function (candidate) {
        byHash[candidate.hash] = candidate;
    });

    function append(candidate) {
        if (candidate && !result.some(function (item) { return item.hash === candidate.hash; })) {
            result.push({hash: candidate.hash, text: candidate.text});
        }
    }

    semanticResults.slice(0, 25).forEach(append);
    nearest.slice(0, 5).forEach(function (example) {
        append(byHash[example.blockHash]);
    });
    semanticResults.slice(25).forEach(append);

    return result.slice(0, limit || 30);
}

function sanitizeModelRanking(ids, shortlist, fallback, topK) {
    const maxItems = topK || DEFAULT_TOP_K;
    const allowed = new Set(shortlist.map(function (candidate) { return candidate.hash; }));
    const result = [];

    (Array.isArray(ids) ? ids : []).forEach(function (hash) {
        if (allowed.has(hash) && !result.includes(hash) && result.length < maxItems) {
            result.push(hash);
        }
    });

    fallback.forEach(function (candidate) {
        if (allowed.has(candidate.hash) && !result.includes(candidate.hash) && result.length < maxItems) {
            result.push(candidate.hash);
        }
    });

    return result;
}

function isCurrentRanking(result, expected) {
    return result && expected && result.turnId === expected.turnId &&
        result.pageHash === expected.pageHash && result.revision === expected.revision;
}

class TranscriptTracker {
    constructor() {
        this.turns = new Map();
    }

    handle(event) {
        const itemId = event.itemId;
        if (!itemId) {
            return null;
        }

        const turn = this.turns.get(itemId) || {
            itemId: itemId,
            transcript: '',
            startedAt: null,
            stoppedAt: null,
            completed: false
        };

        if (event.type === 'speech_started') {
            turn.startedAt = event.timestamp || Date.now();
        } else if (event.type === 'speech_stopped') {
            turn.stoppedAt = event.timestamp || Date.now();
        } else if (event.type === 'transcript_delta') {
            turn.transcript += event.delta || '';
        } else if (event.type === 'transcript_completed') {
            turn.transcript = normalizeText(event.transcript || turn.transcript);
            turn.completed = true;
        }

        this.turns.set(itemId, turn);
        return Object.assign({}, turn);
    }

    clear() {
        this.turns.clear();
    }
}

module.exports = {
    DEFAULT_HISTORY_CHARS,
    DEFAULT_HISTORY_LIMIT,
    DEFAULT_TOP_K,
    TranscriptTracker,
    buildContextText,
    buildScenarioShortlist,
    buildShortlist,
    cosineSimilarity,
    historyTurnText,
    isCurrentRanking,
    nearestExamples,
    normalizeText,
    rankSemanticCandidates,
    rankScenarioCandidates,
    selectRecentHistory,
    selectRelevantHistory,
    sanitizeModelRanking
};
