'use strict';

const DEFAULT_TOP_K = 5;
const DEFAULT_HISTORY_LIMIT = 6;
const DEFAULT_HISTORY_CHARS = 8000;
const PHRASE_DESCRIPTOR_VERSION = 2;
const CALL_PHASES = ['opening', 'engagement', 'development', 'escalation', 'closing'];
const CALL_EMOTIONS = ['neutral', 'confused', 'interested', 'annoyed', 'angry', 'amused', 'uncertain'];
const INCOMING_ACTS = [
    'greeting', 'identity_question', 'connection_problem', 'request', 'accusation', 'insult',
    'question', 'goodbye', 'statement'
];

function normalizeText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
}

function uniqueStrings(values, limit, maxLength) {
    const seen = new Set();
    const result = [];

    (Array.isArray(values) ? values : []).forEach(function (value) {
        const text = normalizeText(value).slice(0, maxLength || 240);
        const key = text.toLowerCase();
        if (text && !seen.has(key) && result.length < (limit || 8)) {
            seen.add(key);
            result.push(text);
        }
    });

    return result;
}

function hasWholeWord(text, alternatives) {
    return new RegExp('(?:^|[^а-яёa-z0-9])(?:' + alternatives + ')(?:$|[^а-яёa-z0-9])', 'iu').test(text);
}

function textTopics(text) {
    const source = normalizeText(text).toLowerCase();
    const topics = [];
    const rules = [
        ['identity', /(кто|имя|зовут|представь|говорит|это я|вы кто|с кем.*разговар)/],
        ['acquaintance', /(знаю|знаете|знаком|помните)/],
        ['connection', /(слыш|связ|алл?о|громче|повтор|пропада)/],
        ['call', /(звон|телефон|трубк|номер)/],
        ['money', /(деньг|рубл|доллар|оплат|плат[её]ж|долг|банк|карт|сч[её]т)/],
        ['location', /(откуда|адрес|улиц|квартир|подъезд|этаж|город|деревн|жив[её]те|бутусов|борисовк|\bиз\s+[а-яё-]+|(?:^|[^а-яё])дом(?:а|е|ой|у|ом)?(?:$|[^а-яё]))/],
        ['activity', /(что\s+(?:(?:вы|ты)\s+)?(?:сейчас\s+)?дел|чем занима|смотрю|гляжу|телевизор|телек|работа|отдыха)/],
        ['visit', /(прид|приход|приезж|в гости)/],
        ['wrong_number', /(ошиблись|не туда попали|не тот номер)/],
        ['authorities', /(полиц|суд|прокурат|служб|началь|заявлен|жалоб)/],
        ['family', /(муж|жен|сын|доч|мам|пап|бабуш|дедуш|родствен)/],
        ['service', /(заказ|достав|услуг|оператор|компан|ремонт|мастер|кабинет)/],
        ['conflict', /(обман|мошенн|вр[её]те|дурак|идиот|сука|бляд|хуй|пош[её]л|угрож)/],
        ['time', /(когда|сегодня|завтра|вчера|минут|утром|вечером|(?:^|[^а-яё])час(?:а|ов|ик)?(?:$|[^а-яё]))/],
        ['holiday', /(рождеств|новым год|поздрав)/]
    ];

    rules.forEach(function (rule) {
        if (rule[1].test(source)) {
            topics.push(rule[0]);
        }
    });
    return topics;
}

function classifyIncomingUtterance(text) {
    const normalized = normalizeText(text);
    const source = normalized.toLowerCase();
    let act = 'statement';

    if (/(не слыш|плохо слыш|связь|повторите|громче|пропадаете|перезвоните)/.test(source)) {
        act = 'connection_problem';
    } else if (/(кто (?:это|вы)|вы кто|как вас зовут|с кем я говорю|представьтесь|кто говорит)/.test(source)) {
        act = 'identity_question';
    } else if (/(здравствуйте|добрый (?:день|вечер|утро)|привет|алл?о|с рождеств|с новым год|поздравля(?:ю|ем))/.test(source)) {
        act = 'greeting';
    } else if (/(до ?свидания|прощайте|всего доброго|не звоните|кладу трубку)/.test(source)) {
        act = 'goodbye';
    } else if (/(дурак|идиот|сука|бляд|хуй|пош[её]л|дебил|тварь)/.test(source)) {
        act = 'insult';
    } else if (/(мошенник|обман|вр[её]те|вы .*звони|вы .*сделал|это вы|ваша вина|угрож|ошиблись номером|не туда попали)/.test(source)) {
        act = 'accusation';
    } else if (/(скажите|позовите|дайте|передайте|сделайте|приезжайте|приходите|не приходите|подождите|перестаньте|уберите)/.test(source)) {
        act = 'request';
    } else if (/\?/.test(source) || hasWholeWord(source,
        'кто|что|где|когда|зачем|почему|как|сколько|какой|какая|какие|кого|кем|кому') ||
        /^(?:а )?(?:ты|вы) .*(?:дома|что ли|из .+ да)$/.test(source)) {
        act = 'question';
    }

    let emotion = 'neutral';
    if (act === 'insult') {
        emotion = 'angry';
    } else if (act === 'accusation') {
        emotion = 'annoyed';
    } else if (act === 'connection_problem') {
        emotion = 'confused';
    } else if (/(ха-?ха|смешно|прикол|шут)/.test(source)) {
        emotion = 'amused';
    } else if (/!{2,}/.test(normalized)) {
        emotion = 'annoyed';
    }

    return {act: act, topics: textTopics(normalized), emotion: emotion};
}

function inferPhraseMetadata(text) {
    const normalized = normalizeText(text);
    const source = normalized.toLowerCase();
    const isQuestion = /\?/.test(source) || hasWholeWord(source,
        'кто|что|где|когда|зачем|почему|как|сколько|какой|какая|какие|кого|кем|кому') ||
        /^(?:а )?(?:ты|вы) .*(?:дома|что ли|из .+ да)$/.test(source);
    const isRepair = /(повтор|не слыш|плохо слыш|громче|связ|не понял|не поняла|не понима|что вы сказали)/.test(source);
    const isAggressive = /(полиц|суд|прокурат|жалоб|накаж|найду|убью|дурак|идиот|сука|бляд|хуй|пош[её]л)/.test(source);
    const topics = textTopics(normalized);
    const isDenial = /^(нет|неа)(?:\s|$)|(не я|не знаю|не буду|не могу|ничего не|никогда|ошиблись|не туда попали|не звонил|не звонила)/.test(source);
    const isGreeting = /(здравствуйте|добрый (?:день|вечер|утро)|привет|алл?о|слушаю|с рождеств|с новым год|поздравля(?:ю|ем))/.test(source);
    const isExit = /(до ?свидания|прощайте|всего доброго|не звоните|кладу трубку|отстаньте)/.test(source);
    const isRequest = /(скажите|позовите|дайте|передайте|подождите|сделайте|приезжайте|приходите|звоните)/.test(source);
    const isAccusation = /(мошенник|обман|вр[её]те|это вы|ваша вина|вы .*звони)/.test(source);
    const isSelfIdentification = /^(?:(?:ну|а)\s+)?я\s+[а-яё-]+(?:\s+[а-яё-]+){0,2}$/.test(source) ||
        /^[а-яё-]+\s+это$/.test(source) || /(это я|меня зовут)/.test(source);
    const isLocationAnswer = topics.includes('location') && normalized.split(' ').length <= 4;
    const isActivityAnswer = /(смотрю|гляжу|занимаюсь|работаю|отдыхаю)/.test(source);
    const isAnswer = /^(?:да|ага|конечно|конечн|верно|правильно|хорошо|оч хорошо|спасибо)(?:\s|$)/.test(source) ||
        /(это я|меня зовут|я говорю|я живу|мой адрес|знаю)/.test(source) ||
        isSelfIdentification ||
        /^(?:(?:ну|а)\s+)?(?:это\s+)?из\s+[а-яё-]+$/.test(source) ||
        isActivityAnswer || isLocationAnswer;

    if (isSelfIdentification && !topics.includes('identity')) {
        topics.push('identity');
    }

    let dialogueAct = 'statement';
    if (isExit) {
        dialogueAct = 'exit';
    } else if (isGreeting) {
        dialogueAct = 'greeting';
    } else if (isRepair) {
        dialogueAct = 'repair';
    } else if (isAggressive) {
        dialogueAct = 'escalation';
    } else if (isAccusation) {
        dialogueAct = 'accusation';
    } else if (isDenial) {
        dialogueAct = 'denial';
    } else if (isRequest) {
        dialogueAct = 'request';
    } else if (isQuestion) {
        dialogueAct = 'counter_question';
    } else if (isAnswer) {
        dialogueAct = 'answer';
    }

    const tactics = [];
    const answersTo = [];
    if (dialogueAct === 'greeting') {
        tactics.push('opening', 'direct');
        answersTo.push('greeting');
    } else if (dialogueAct === 'repair') {
        tactics.push('repair', 'neutral');
        answersTo.push('connection_problem', 'question');
    } else if (dialogueAct === 'counter_question') {
        tactics.push('counter', 'scenario');
        answersTo.push('question', 'identity_question', 'request', 'accusation', 'insult');
    } else if (dialogueAct === 'denial') {
        tactics.push('direct', 'escalation');
        answersTo.push('accusation', 'request', 'question');
    } else if (dialogueAct === 'answer') {
        tactics.push('direct', 'neutral');
        answersTo.push('question', 'identity_question', 'request');
    } else if (dialogueAct === 'escalation' || dialogueAct === 'accusation') {
        tactics.push('escalation', 'scenario');
        answersTo.push('accusation', 'insult', 'statement');
    } else if (dialogueAct === 'exit') {
        tactics.push('exit');
        answersTo.push('goodbye', 'insult');
    } else if (dialogueAct === 'request') {
        tactics.push('scenario', 'direct');
        answersTo.push('statement', 'question', 'request');
    } else {
        tactics.push('scenario', 'neutral');
        answersTo.push('statement', 'question');
    }

    let tone = 'neutral';
    if (isAggressive || isAccusation) {
        tone = 'aggressive';
    } else if (isRepair) {
        tone = 'confused';
    } else if (isGreeting) {
        tone = 'friendly';
    } else if (isDenial || isRequest) {
        tone = 'assertive';
    }

    const wordCount = normalized ? normalized.split(' ').length : 0;
    const specificity = /\d|(адрес|улиц|дом|квартир|рубл|имя|зовут)/.test(source) || wordCount > 12 ?
        'high' : wordCount > 5 ? 'medium' : 'low';
    const scenarioStages = dialogueAct === 'greeting' ? ['opening'] : dialogueAct === 'exit' ? ['closing'] :
        (dialogueAct === 'escalation' || dialogueAct === 'accusation') ? ['escalation'] :
            ['engagement', 'development'];

    return {
        dialogueAct: dialogueAct,
        tactics: uniqueStrings(tactics, 4, 40),
        answersTo: uniqueStrings(answersTo, 6, 40),
        topics: topics,
        tone: tone,
        specificity: specificity,
        canOpen: dialogueAct === 'greeting',
        canRepair: dialogueAct === 'repair',
        canExit: dialogueAct === 'exit',
        scenarioStages: scenarioStages
    };
}

function buildPhraseDescriptor(candidate) {
    const text = normalizeText(candidate && candidate.text);
    const metadata = candidate && candidate.metadata ? candidate.metadata : inferPhraseMetadata(text);
    return [
        'Записанная реплика: ' + text,
        'Смысл готового ответа: ' + text,
        'Речевой акт и тактика: ' + metadata.dialogueAct + '; ' + metadata.tactics.join(', '),
        'Подходит после: ' + metadata.answersTo.join(', '),
        'Темы и тон: ' + (metadata.topics.join(', ') || 'общая') + '; ' + metadata.tone
    ].join('\n');
}

function createCallState() {
    return {
        phase: 'opening',
        activeTopic: '',
        establishedFacts: [],
        unresolvedQuestions: [],
        lastInterlocutorAct: 'statement',
        lastQuestionOrAction: '',
        emotion: 'neutral',
        callbacks: []
    };
}

function sanitizeCallState(state) {
    const source = state || {};
    const result = createCallState();
    result.phase = CALL_PHASES.includes(source.phase) ? source.phase : result.phase;
    result.activeTopic = normalizeText(source.activeTopic).slice(0, 120);
    result.establishedFacts = uniqueStrings(source.establishedFacts, 8, 240);
    result.unresolvedQuestions = uniqueStrings(source.unresolvedQuestions, 6, 240);
    result.lastInterlocutorAct = INCOMING_ACTS.includes(source.lastInterlocutorAct) ?
        source.lastInterlocutorAct : result.lastInterlocutorAct;
    result.lastQuestionOrAction = normalizeText(source.lastQuestionOrAction).slice(0, 240);
    result.emotion = CALL_EMOTIONS.includes(source.emotion) ? source.emotion : result.emotion;
    result.callbacks = uniqueStrings(source.callbacks, 6, 240);
    return result;
}

function advanceCallState(state, transcript) {
    const result = sanitizeCallState(state);
    const text = normalizeText(transcript);
    const incoming = classifyIncomingUtterance(text);

    result.lastInterlocutorAct = incoming.act;
    result.emotion = incoming.emotion;
    if (incoming.topics.length > 0) {
        result.activeTopic = incoming.topics[0];
    }
    if (['question', 'identity_question', 'request', 'accusation', 'connection_problem'].includes(incoming.act)) {
        result.lastQuestionOrAction = text.slice(0, 240);
    }
    if (['question', 'identity_question'].includes(incoming.act) && text) {
        result.unresolvedQuestions = uniqueStrings(result.unresolvedQuestions.concat(text), 6, 240);
    }
    if (incoming.act === 'goodbye') {
        result.phase = 'closing';
    } else if (['insult', 'accusation'].includes(incoming.act)) {
        result.phase = 'escalation';
    } else if (result.phase === 'opening' && incoming.act !== 'greeting') {
        result.phase = 'engagement';
    } else if (result.phase === 'engagement' && !['greeting', 'connection_problem'].includes(incoming.act)) {
        result.phase = 'development';
    }

    return result;
}

function buildIncomingDescriptor(transcript, callState) {
    const text = normalizeText(transcript);
    const incoming = classifyIncomingUtterance(text);
    const state = sanitizeCallState(callState);
    return [
        'Реплика собеседника: ' + text,
        'Смысл входящей реплики: ' + text,
        'Тип входа: ' + incoming.act,
        'Темы и эмоция: ' + (incoming.topics.join(', ') || 'общая') + '; ' + incoming.emotion,
        'Этап и активная тема: ' + state.phase + '; ' + (state.activeTopic || 'не задана')
    ].join('\n');
}

function parseScenarioPlan(prompt) {
    const result = {
        legend: '',
        goal: '',
        facts: [],
        stages: [],
        triggers: [],
        forbidden: [],
        callbacks: [],
        notes: ''
    };
    const headings = {
        'легенда': 'legend',
        'роль': 'legend',
        'цель': 'goal',
        'факты': 'facts',
        'этапы': 'stages',
        'триггеры': 'triggers',
        'нельзя': 'forbidden',
        'запреты': 'forbidden',
        'колбэки': 'callbacks',
        'callback': 'callbacks'
    };
    let section = 'notes';

    String(prompt || '').split(/\r?\n/).forEach(function (rawLine) {
        const line = rawLine.trim();
        if (!line) {
            return;
        }
        const match = line.match(/^([^:]{2,24}):\s*(.*)$/);
        if (match && headings[match[1].trim().toLowerCase()]) {
            section = headings[match[1].trim().toLowerCase()];
            if (!match[2]) {
                return;
            }
            if (Array.isArray(result[section])) {
                result[section].push(match[2]);
            } else {
                result[section] = normalizeText([result[section], match[2]].filter(Boolean).join(' '));
            }
            return;
        }

        const value = line.replace(/^(?:[-*]\s+|\d+[.)]\s*)/, '').trim();
        if (Array.isArray(result[section])) {
            result[section].push(value);
        } else {
            result[section] = normalizeText([result[section], line].filter(Boolean).join(' '));
        }
    });

    result.facts = uniqueStrings(result.facts, 20, 400);
    result.stages = uniqueStrings(result.stages, 20, 400);
    result.triggers = uniqueStrings(result.triggers, 20, 400);
    result.forbidden = uniqueStrings(result.forbidden, 20, 400);
    result.callbacks = uniqueStrings(result.callbacks, 20, 400);
    return result;
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

function feedbackExampleScore(example) {
    const similarity = Math.max(0, Number(example.similarity) || 0);
    const count = Math.max(1, Number(example.count) || 1);
    const outsideCount = Math.max(0, Number(example.outsideTopKCount) || 0);
    const repeatBonus = Math.min(0.15, Math.log2(count + 1) * 0.05);
    const outsideBonus = Math.min(0.25, (outsideCount / count) * 0.25);
    return Math.min(1.4, similarity * (1 + repeatBonus + outsideBonus));
}

function scenarioLexicalCompatibility(text, scenarioText) {
    const candidateTokens = new Set((normalizeText(text).toLowerCase().match(/[а-яёa-z0-9-]{4,}/giu) || []));
    if (candidateTokens.size === 0) {
        return 0;
    }
    const scenarioTokens = new Set((normalizeText(scenarioText).toLowerCase().match(/[а-яёa-z0-9-]{4,}/giu) || []));
    let matches = 0;
    candidateTokens.forEach(function (token) {
        if (scenarioTokens.has(token)) {
            matches += 1;
        }
    });
    return Math.min(1, matches / candidateTokens.size);
}

function quickLexicalTokens(text) {
    const stopWords = new Set([
        'это', 'как', 'что', 'кто', 'где', 'когда', 'зачем', 'почему', 'какой', 'какая', 'какие',
        'меня', 'мне', 'тебя', 'тебе', 'вам', 'вас', 'они', 'она', 'оно', 'или', 'уже', 'сейчас',
        'только', 'просто', 'очень', 'тоже', 'быть', 'есть', 'был', 'была', 'были'
    ]);
    return new Set((normalizeText(text).toLowerCase().replaceAll('ё', 'е').match(/[а-яa-z0-9-]{3,}/giu) || [])
        .filter(function (token) { return !stopWords.has(token); })
        .map(function (token) { return token.length > 5 ? token.slice(0, 5) : token; }));
}

function quickLexicalSimilarity(leftText, rightText) {
    const left = quickLexicalTokens(leftText);
    const right = quickLexicalTokens(rightText);
    if (left.size === 0 || right.size === 0) {
        return 0;
    }

    let matches = 0;
    left.forEach(function (token) {
        if (right.has(token)) {
            matches += 1;
        }
    });
    return matches / Math.max(1, Math.min(left.size, right.size));
}

function rankQuickCandidates(candidates, transcript, scenarioText, options, topK) {
    const incoming = classifyIncomingUtterance(transcript);
    const settings = options || {};
    const recent = new Set(Array.isArray(settings.recentHashes) ? settings.recentHashes : []);
    const ranked = (Array.isArray(candidates) ? candidates : []).map(function (candidate) {
        const metadata = inferPhraseMetadata(candidate.text);
        const compatibilityScore = tacticCompatibility(incoming, metadata);
        const topicMatches = incoming.topics.filter(function (topic) { return metadata.topics.includes(topic); }).length;
        const topicScore = incoming.topics.length > 0 ? topicMatches / incoming.topics.length : 0;
        const lexicalScore = quickLexicalSimilarity(transcript, candidate.text);
        const scenarioScore = scenarioLexicalCompatibility(candidate.text, scenarioText);
        const recentlyPlayed = recent.has(candidate.hash);
        const score = (0.48 * compatibilityScore) + (0.28 * lexicalScore) + (0.16 * topicScore) +
            (0.08 * scenarioScore) + (recentlyPlayed ? 0.03 : 0);

        return Object.assign({}, candidate, {
            score: score,
            currentScore: lexicalScore,
            scenarioScore: scenarioScore,
            feedbackScore: 0,
            compatibilityScore: compatibilityScore,
            metadata: metadata,
            tactics: recentlyPlayed ? ['callback'].concat(metadata.tactics) : metadata.tactics.slice(),
            tactic: primaryTactic(metadata, incoming, recentlyPlayed),
            recentlyPlayed: recentlyPlayed
        });
    }).filter(function (candidate) {
        return candidate.hash && normalizeText(candidate.text) && candidate.score > 0;
    }).sort(function (left, right) {
        if (right.score === left.score) {
            return left.hash.localeCompare(right.hash);
        }
        return right.score - left.score;
    });

    return selectDiverseSuggestions(ranked, incoming, topK || DEFAULT_TOP_K);
}

function tacticCompatibility(incoming, metadata) {
    const source = incoming || classifyIncomingUtterance('');
    const phrase = metadata || inferPhraseMetadata('');
    const actMatch = phrase.answersTo.includes(source.act);
    const topicMatch = source.topics.some(function (topic) { return phrase.topics.includes(topic); });
    if (actMatch && topicMatch) {
        return 1;
    }
    if (actMatch) {
        return source.topics.length > 0 ? 0.65 : 1;
    }

    const desired = {
        greeting: ['opening', 'direct'],
        identity_question: ['direct', 'counter'],
        connection_problem: ['repair', 'direct'],
        request: ['direct', 'counter', 'scenario'],
        accusation: ['direct', 'counter', 'escalation'],
        insult: ['counter', 'escalation', 'repair'],
        question: ['direct', 'counter', 'repair'],
        goodbye: ['exit', 'counter'],
        statement: ['scenario', 'direct', 'counter']
    }[source.act] || ['scenario', 'neutral'];
    const tacticMatch = phrase.tactics.some(function (tactic) { return desired.includes(tactic); });
    if (tacticMatch && topicMatch) {
        return 0.85;
    }
    if (tacticMatch) {
        return 0.65;
    }
    if (topicMatch) {
        return 0.45;
    }
    return phrase.tactics.includes('neutral') ? 0.25 : 0;
}

function primaryTactic(metadata, incoming, recentlyPlayed) {
    if (recentlyPlayed) {
        return 'callback';
    }
    const order = tacticOrder(incoming && incoming.act);
    return order.find(function (tactic) { return metadata.tactics.includes(tactic); }) ||
        metadata.tactics[0] || 'neutral';
}

function rankScenarioCandidates(candidates, indexEntries, examples, embeddings, scenarioId, options, topK) {
    const exampleScores = {};
    const feedbackEmbedding = embeddings.feedback || embeddings.current;
    const settings = options || {};
    const incoming = settings.incoming || classifyIncomingUtterance('');
    const recent = new Set(Array.isArray(settings.recentHashes) ? settings.recentHashes : []);

    nearestExamples(examples, feedbackEmbedding, scenarioId, examples.length).forEach(function (example) {
        const score = feedbackExampleScore(example);
        exampleScores[example.blockHash] = Math.max(exampleScores[example.blockHash] || 0, score);
    });

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
            const metadata = entry.metadata || inferPhraseMetadata(candidate.text);
            const compatibilityScore = tacticCompatibility(incoming, metadata);
            const topicMatch = incoming.topics.some(function (topic) { return metadata.topics.includes(topic); });
            const scenarioLexicalScore = scenarioLexicalCompatibility(candidate.text, settings.scenarioText) *
                (incoming.topics.length === 0 || topicMatch ? 1 : 0);
            const recentlyPlayed = recent.has(candidate.hash);

            return Object.assign({}, candidate, {
                score: (0.5 * currentScore) + (0.2 * scenarioScore) + (0.2 * feedbackScore) +
                    (0.1 * compatibilityScore) + (0.06 * scenarioLexicalScore),
                currentScore: currentScore,
                scenarioScore: scenarioScore,
                feedbackScore: feedbackScore,
                compatibilityScore: compatibilityScore,
                scenarioLexicalScore: scenarioLexicalScore,
                metadata: metadata,
                tactics: recentlyPlayed ? ['callback'].concat(metadata.tactics) : metadata.tactics.slice(),
                tactic: primaryTactic(metadata, incoming, recentlyPlayed),
                recentlyPlayed: recentlyPlayed
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

function tacticOrder(act) {
    const orders = {
        greeting: ['opening', 'direct', 'counter', 'repair', 'scenario', 'escalation'],
        identity_question: ['direct', 'counter', 'repair', 'scenario', 'escalation'],
        connection_problem: ['repair', 'direct', 'counter', 'scenario', 'escalation'],
        request: ['direct', 'counter', 'scenario', 'repair', 'escalation'],
        accusation: ['direct', 'counter', 'escalation', 'repair', 'scenario'],
        insult: ['counter', 'escalation', 'direct', 'repair', 'scenario'],
        question: ['direct', 'counter', 'repair', 'scenario', 'escalation'],
        goodbye: ['exit', 'counter', 'direct', 'scenario', 'escalation'],
        statement: ['scenario', 'direct', 'counter', 'repair', 'escalation']
    };
    return orders[act] || orders.statement;
}

function supportsTactic(candidate, tactic) {
    const tactics = candidate.tactics || (candidate.metadata && candidate.metadata.tactics) || [];
    if (tactic === 'callback') {
        return Boolean(candidate.recentlyPlayed) || tactics.includes('callback');
    }
    if (tactic === 'neutral') {
        return tactics.includes('neutral') || tactics.includes('repair');
    }
    return tactics.includes(tactic);
}

function selectDiverseSuggestions(ranked, incoming, topK) {
    const source = Array.isArray(ranked) ? ranked : [];
    const maxItems = topK || DEFAULT_TOP_K;
    if (source.length === 0) {
        return [];
    }

    const result = [];
    const seen = new Set();
    const qualityFloor = source[0].score - 0.1;
    const order = tacticOrder(incoming && incoming.act);
    if (source.some(function (candidate) { return candidate.recentlyPlayed; })) {
        order.splice(Math.min(4, order.length), 0, 'callback');
    }

    order.forEach(function (tactic) {
        if (result.length >= maxItems) {
            return;
        }
        const candidate = source.find(function (item) {
            return !seen.has(item.hash) && item.score >= qualityFloor && supportsTactic(item, tactic);
        });
        if (candidate) {
            seen.add(candidate.hash);
            result.push(Object.assign({}, candidate, {tactic: tactic}));
        }
    });

    source.forEach(function (candidate) {
        if (result.length < maxItems && !seen.has(candidate.hash)) {
            seen.add(candidate.hash);
            result.push(candidate);
        }
    });
    return result.slice(0, maxItems);
}

function buildScenarioShortlist(ranked, candidates, nearest, incoming, limit) {
    const maxItems = limit || 40;
    const byHash = {};
    const result = [];

    candidates.forEach(function (candidate) { byHash[candidate.hash] = candidate; });

    function append(candidate) {
        if (candidate && !result.some(function (item) { return item.hash === candidate.hash; })) {
            const merged = Object.assign({}, byHash[candidate.hash] || {}, candidate);
            merged.metadata = merged.metadata || inferPhraseMetadata(merged.text);
            merged.tactics = merged.tactics || merged.metadata.tactics;
            merged.tactic = merged.tactic || primaryTactic(merged.metadata, incoming, merged.recentlyPlayed);
            result.push(merged);
        }
    }

    ranked.slice().sort(function (left, right) { return right.currentScore - left.currentScore; })
        .slice(0, 10).forEach(append);
    tacticOrder(incoming && incoming.act).forEach(function (tactic) {
        ranked.filter(function (candidate) { return supportsTactic(candidate, tactic); })
            .slice(0, tactic === 'scenario' ? 8 : 5).forEach(append);
    });
    ranked.slice().sort(function (left, right) { return right.scenarioScore - left.scenarioScore; })
        .slice(0, 8).forEach(append);
    ranked.slice().sort(function (left, right) { return right.feedbackScore - left.feedbackScore; })
        .slice(0, 6).forEach(append);
    nearest.slice(0, 6).forEach(function (example) { append(byHash[example.blockHash]); });
    ranked.forEach(append);

    return result.slice(0, maxItems);
}

function stabilizeSuggestionSlots(previous, incoming, limit) {
    const maxItems = limit || DEFAULT_TOP_K;
    const next = (Array.isArray(incoming) ? incoming : []).slice(0, maxItems);
    const byHash = new Map(next.map(function (candidate) { return [candidate.hash, candidate]; }));
    const result = new Array(Math.min(maxItems, next.length));
    const used = new Set();

    (Array.isArray(previous) ? previous : []).slice(0, result.length).forEach(function (candidate, index) {
        if (candidate && byHash.has(candidate.hash)) {
            result[index] = byHash.get(candidate.hash);
            used.add(candidate.hash);
        }
    });

    const remaining = next.filter(function (candidate) { return !used.has(candidate.hash); });
    for (let index = 0; index < result.length; index++) {
        if (!result[index]) {
            result[index] = remaining.shift();
        }
    }
    return result.filter(Boolean);
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
    CALL_EMOTIONS,
    CALL_PHASES,
    DEFAULT_HISTORY_CHARS,
    DEFAULT_HISTORY_LIMIT,
    DEFAULT_TOP_K,
    INCOMING_ACTS,
    PHRASE_DESCRIPTOR_VERSION,
    TranscriptTracker,
    advanceCallState,
    buildContextText,
    buildIncomingDescriptor,
    buildPhraseDescriptor,
    buildScenarioShortlist,
    buildShortlist,
    classifyIncomingUtterance,
    cosineSimilarity,
    createCallState,
    historyTurnText,
    inferPhraseMetadata,
    isCurrentRanking,
    nearestExamples,
    normalizeText,
    parseScenarioPlan,
    rankQuickCandidates,
    rankSemanticCandidates,
    rankScenarioCandidates,
    sanitizeCallState,
    selectRecentHistory,
    selectDiverseSuggestions,
    selectRelevantHistory,
    sanitizeModelRanking,
    stabilizeSuggestionSlots,
    tacticCompatibility
};
