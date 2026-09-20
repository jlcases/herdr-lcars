import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { SOUND_CUES, makeBeeper, soundCueForEvent } from '../public/shared.js';

class FakeAudioParam {
  events = [];

  setValueAtTime(value, at) {
    this.events.push({ kind: 'set', value, at });
  }

  exponentialRampToValueAtTime(value, at) {
    this.events.push({ kind: 'ramp', value, at });
  }
}

class FakeAudioContext {
  currentTime = 10;
  destination = {};
  state = 'running';
  oscillators = [];
  gains = [];

  createOscillator() {
    const oscillator = {
      type: null,
      frequency: new FakeAudioParam(),
      connect: (target) => { oscillator.target = target; },
      start: (at) => { oscillator.startedAt = at; },
      stop: (at) => { oscillator.stoppedAt = at; },
    };
    this.oscillators.push(oscillator);
    return oscillator;
  }

  createGain() {
    const gain = {
      gain: new FakeAudioParam(),
      connect: (target) => { gain.target = target; },
    };
    this.gains.push(gain);
    return gain;
  }
}

test('sonido: solo las transiciones nuevas a terminado o bloqueado generan aviso', () => {
  assert.equal(soundCueForEvent({ kind: 'status', from: 'working', to: 'done' }), 'done');
  assert.equal(soundCueForEvent({ kind: 'status', from: 'working', to: 'blocked' }), 'blocked');
  assert.equal(soundCueForEvent({ kind: 'status', from: 'done', to: 'idle' }), null);
  assert.equal(soundCueForEvent({ kind: 'turn_done' }), null, 'el evento de telemetría no debe duplicar el terminado');
  assert.equal(soundCueForEvent(null), null);
});

test('sonido: OFF no crea AudioContext ni programa tonos', () => {
  let contexts = 0;
  const beep = makeBeeper(() => false, {
    createAudioContext: () => { contexts++; return new FakeAudioContext(); },
  });
  assert.equal(beep('blocked'), false);
  assert.equal(contexts, 0);
});

test('sonido: terminado es breve y bloqueo es una alarma inequívoca y más intensa', () => {
  const audio = new FakeAudioContext();
  const beep = makeBeeper(() => true, { createAudioContext: () => audio });

  assert.equal(beep('done'), true);
  const doneOscillators = audio.oscillators.splice(0);
  const doneGains = audio.gains.splice(0);

  assert.equal(beep('blocked'), true);
  const blockedOscillators = audio.oscillators;
  const blockedGains = audio.gains;

  assert.equal(doneOscillators.length, SOUND_CUES.done.tones.length);
  assert.equal(blockedOscillators.length, SOUND_CUES.blocked.tones.length);
  assert.ok(blockedOscillators.length > doneOscillators.length, 'el bloqueo debe tener más pulsos');
  assert.ok(blockedOscillators.every((oscillator) => oscillator.type === 'square'));
  assert.ok(doneOscillators.every((oscillator) => oscillator.type === 'sine'));
  assert.ok(
    Math.max(...blockedOscillators.map((oscillator) => oscillator.stoppedAt))
      > Math.max(...doneOscillators.map((oscillator) => oscillator.stoppedAt)),
    'la alarma de bloqueo debe durar más',
  );
  const peak = (gains) => Math.max(...gains.flatMap((gain) => gain.gain.events.map((event) => event.value)));
  assert.ok(peak(blockedGains) > peak(doneGains), 'la alarma de bloqueo debe tener mayor ganancia');
});

test('sonido: reconstruir el historial es silencioso en ambas vistas', async () => {
  const sources = await Promise.all([
    fsp.readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    fsp.readFile(new URL('../public/msd.js', import.meta.url), 'utf8'),
  ]);
  for (const source of sources) {
    assert.match(source, /ticker\.add\(ev, \{ announce: false \}\)/);
    assert.match(source, /onSound:/);
  }
});
