'use strict';

const {ipcRenderer} = require('electron');

const tacticLabels = {
    opening: 'вход',
    direct: 'ответ',
    counter: 'встречный',
    repair: 'уточнение',
    neutral: 'нейтрально',
    scenario: 'сценарий',
    escalation: 'нажим',
    callback: 'callback',
    exit: 'выход'
};

let suggestions = [];

function renderSuggestions(items, final) {
    const list = document.querySelector('#ai-companion-list');
    suggestions = Array.isArray(items) ? items.slice(0, 5) : [];
    list.replaceChildren();

    if (suggestions.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'ai-empty';
        empty.textContent = 'Подсказки появятся во время речи';
        list.appendChild(empty);
        return;
    }

    suggestions.forEach(function (suggestion, index) {
        const button = document.createElement('button');
        button.className = 'button ai-suggestion' + (final ? ' is-final' : ' is-provisional');
        button.dataset.hash = suggestion.hash;

        const key = document.createElement('span');
        key.className = 'ai-suggestion-key';
        key.textContent = String(index + 1);

        const text = document.createElement('span');
        text.className = 'ai-suggestion-text';
        text.textContent = suggestion.text;

        const tactic = document.createElement('span');
        tactic.className = 'ai-suggestion-tactic';
        tactic.textContent = tacticLabels[suggestion.tactic] || suggestion.tactic || '';

        button.append(key, text, tactic);
        button.addEventListener('click', function () {
            ipcRenderer.send('ai:companion:play', suggestion.hash);
        });
        list.appendChild(button);
    });
}

function render(snapshot) {
    const state = snapshot || {};
    const status = document.querySelector('#ai-companion-status');
    status.dataset.status = state.status || 'stopped';
    document.querySelector('#ai-companion-status-text').textContent = state.statusText || 'AI выключен';
    document.querySelector('#ai-companion-character').textContent = state.pageName || 'Текущий персонаж';
    document.querySelector('#ai-companion-cost').textContent = state.cost || '';

    const transcript = document.querySelector('#ai-companion-transcript');
    transcript.textContent = state.transcript || 'Ожидаю речь…';
    transcript.classList.toggle('is-final', Boolean(state.transcriptFinal));
    document.querySelector('#ai-companion-call-state').textContent = state.callState || 'Этап: вход';
    document.querySelector('#ai-companion-stage').textContent = state.stage || '';
    renderSuggestions(state.suggestions, state.suggestionsFinal);
}

window.addEventListener('DOMContentLoaded', function () {
    ipcRenderer.on('ai:companion:update', function (event, snapshot) {
        render(snapshot);
    });
    ipcRenderer.send('ai:companion:ready');
});

window.addEventListener('keydown', function (event) {
    if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || !/^[1-5]$/.test(event.key)) {
        return;
    }
    const suggestion = suggestions[Number(event.key) - 1];
    if (suggestion) {
        event.preventDefault();
        ipcRenderer.send('ai:companion:play', suggestion.hash);
    }
});
