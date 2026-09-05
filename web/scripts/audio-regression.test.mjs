import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';

// Exercise the production functions without opening a real microphone.
const source = readFileSync(new URL('../src/app.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('app.ts', source, ts.ScriptTarget.Latest, true);
const names = new Set(['setNoiseMode', 'audioLevel', 'startSpeaking']);
const functions = ast.statements.filter(s => ts.isFunctionDeclaration(s) && names.has(s.name?.text))
  .map(s => s.getText(ast)).join('\n');
const code = ts.transpile(functions, { target: ts.ScriptTarget.ES2022 });
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  const oldTrack = { enabled: false };
  const nextTrack = { enabled: true };
  let stopped = 0;
  const stream = { getAudioTracks: () => [nextTrack], getTracks: () => [{ stop: () => stopped++ }] };
  const state = {
    noiseMode: 'off', joining: false, changingNoiseMode: false,
    outgoingTrack: oldTrack, outgoingStream: undefined, outgoingAi: undefined,
    noiseButtons: [{ disabled: false }], localStorage: { setItem() {} },
    updateNoiseUi() {}, diagnosticLog() {}, closeAi() {},
    createAiAudio: async () => ({ outputTrack: nextTrack }),
    captureDirect: async () => stream,
    microphoneProducer: { closed: false, replaceTrack: async () => {} },
    statsTimer: undefined, remoteAudio: new Map(), setSpeaking() {},
    window: { setInterval(fn) { state.sample = fn; return 1; } },
  };
  vm.createContext(state);
  vm.runInContext(code, state);
  return { state, nextTrack, stopped: () => stopped };
}

test('simultaneous speech does not change incoming volume in AI or Off', async () => {
  for (const mode of ['off', 'ai']) {
    const { state } = fixture();
    state.noiseMode = mode;
    state.microphoneProducer.getStats = async () => new Map([['mic', { audioLevel: 0.8 }]]);
    const audio = { volume: 0.65 };
    state.remoteAudio.set('peer', { peerId: 'peer', audio,
      consumer: { getStats: async () => new Map([['remote', { audioLevel: 0.8 }]]) } });
    state.startSpeaking();
    for (let i = 0; i < 15; i++) { state.sample(); await tick(); }
    assert.equal(audio.volume, 0.65);
  }
});

test('switching to AI preserves mute, including a hotkey during replacement', async () => {
  const { state, nextTrack } = fixture();
  state.microphoneProducer.replaceTrack = async ({ track }) => {
    assert.equal(track.enabled, false);
    state.outgoingTrack.enabled = true;
  };
  await state.setNoiseMode('ai');
  assert.equal(nextTrack.enabled, true);
  assert.equal(state.noiseMode, 'ai');
  assert.equal(state.changingNoiseMode, false);
});

test('failed mode replacement retains old audio and releases new capture', async () => {
  const { state, stopped } = fixture();
  state.noiseMode = 'ai';
  const previous = state.outgoingTrack;
  state.microphoneProducer.replaceTrack = async () => { throw Error('sender closed'); };
  await state.setNoiseMode('off');
  assert.equal(state.noiseMode, 'ai');
  assert.equal(state.outgoingTrack, previous);
  assert.equal(stopped(), 1);
  assert.equal(state.noiseButtons[0].disabled, false);
});

test('overlapping mode switches do not start a second audio pipeline', async () => {
  const { state } = fixture();
  let finish;
  let captures = 0;
  state.createAiAudio = () => { captures++; return new Promise(resolve => { finish = resolve; }); };
  const first = state.setNoiseMode('ai');
  await state.setNoiseMode('ai');
  assert.equal(captures, 1);
  finish({ outputTrack: { enabled: true } });
  await first;
});
