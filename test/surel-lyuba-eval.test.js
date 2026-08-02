'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const {rankQuickCandidates} = require('../ai-core');
const fixture = require('./fixtures/surel-lyuba-eval.json');

const LIBRARY_PATH = process.env.SUREL_LYUBA_DIR || path.join(os.homedir(), 'Downloads', 'surel_lyuba');

function comparable(text) {
    return String(text || '').normalize('NFC').toLowerCase().replaceAll('ё', 'е');
}

test('Surel Lyuba quick ranking reaches 70% top-5 recall on real phrase names', function (t) {
    if (!fs.existsSync(LIBRARY_PATH)) {
        t.skip('Локальная библиотека Сурель отсутствует');
        return;
    }

    const files = fs.readdirSync(LIBRARY_PATH)
        .filter(function (file) { return path.extname(file).toLowerCase() === '.mp3'; })
        .sort(function (left, right) { return left.localeCompare(right, 'ru'); });
    assert.equal(files.length, 77, 'Ожидалось 77 реальных mp3-файлов Сурель');
    assert.equal(fixture.cases.length, 30, 'Eval должен содержать ровно 30 входящих реплик');

    const candidates = files.map(function (file) {
        return {
            hash: file,
            text: path.basename(file, path.extname(file))
        };
    });
    const candidateNames = candidates.map(function (candidate) { return comparable(candidate.text); });
    const failures = [];
    let hits = 0;

    fixture.cases.forEach(function (entry) {
        assert.equal(candidateNames.includes(comparable(entry.input)), false,
            'Входящая реплика не должна дословно повторять название mp3: ' + entry.input);
        entry.acceptable.forEach(function (substring) {
            assert.equal(candidateNames.some(function (name) {
                return name.includes(comparable(substring));
            }), true, 'Нет mp3 с допустимой подстрокой: ' + substring);
        });

        const topFive = rankQuickCandidates(candidates, entry.input, fixture.scenario, {}, 5);
        const hit = topFive.some(function (candidate) {
            const name = comparable(candidate.text);
            return entry.acceptable.some(function (substring) {
                return name.includes(comparable(substring));
            });
        });

        if (hit) {
            hits += 1;
        } else {
            failures.push({
                input: entry.input,
                topFive: topFive.map(function (candidate) { return candidate.text; }),
                acceptable: entry.acceptable
            });
        }
    });

    const recall = hits / fixture.cases.length;
    t.diagnostic('Surel Lyuba top-5 recall: ' + hits + '/' + fixture.cases.length +
        ' = ' + (recall * 100).toFixed(1) + '%');
    assert.ok(recall >= 0.70, 'Recall ниже 70%:\n' + JSON.stringify(failures, null, 2));
});
