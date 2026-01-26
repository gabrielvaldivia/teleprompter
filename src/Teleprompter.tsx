import { useState, useEffect, useRef, useCallback, useMemo } from 'react';

type Sentence = { raw: string; words: { text: string }[] };

function parseContentToSentences(content: string): { sentences: Sentence[]; separators: string[] } {
  const trimmed = content.trim();
  if (!trimmed) return { sentences: [], separators: [] };
  // Split on sentence-ending punctuation but capture the following whitespace (keeps \n, \n\n, etc.)
  const parts = trimmed.split(/(?<=[.!?])(\s*)/);
  const sentences: Sentence[] = [];
  const separators: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0 && parts[i].length > 0) {
      const raw = parts[i];
      const words = raw.split(/\s+/).filter(Boolean).map((text) => ({ text }));
      sentences.push({ raw, words });
    } else if (i % 2 === 1) {
      separators.push(parts[i]);
    }
  }
  return { sentences, separators };
}

function normalizeWord(w: string): string {
  return w.toLowerCase().replace(/[^\w]/g, '');
}

const VOICE_SUPPORTED =
  typeof window !== 'undefined' &&
  (window.SpeechRecognition != null || window.webkitSpeechRecognition != null);

export default function Teleprompter() {
  const [content, setContent] = useState('');
  const [textInput, setTextInput] = useState('');
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState(50);
  const [fontSize, setFontSize] = useState(48);
  const [showSettings, setShowSettings] = useState(false);
  const [lineHeight, setLineHeight] = useState(1.5);
  const [elapsedTime, setElapsedTime] = useState(0);
  const [mode, setMode] = useState<'auto' | 'voice'>('auto');
  const [spokenWordCount, setSpokenWordCount] = useState(0);
  const [voiceError, setVoiceError] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const animationRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number>(0);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const fatalErrorRef = useRef(false);
  const sentenceRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const scriptWordsRef = useRef<string[]>([]);
  const sentenceEndGlobalIndexRef = useRef<number[]>([]);

  const { sentences, separators } = useMemo(() => parseContentToSentences(content), [content]);
  const flatWords = useMemo(() => sentences.flatMap((s) => s.words.map((w) => w.text)), [sentences]);
  const sentenceEndGlobalIndices = useMemo(() => {
    const out: number[] = [];
    let idx = 0;
    for (const s of sentences) {
      idx += s.words.length;
      out.push(idx - 1);
    }
    return out;
  }, [sentences]);

  useEffect(() => {
    scriptWordsRef.current = flatWords;
    sentenceEndGlobalIndexRef.current = sentenceEndGlobalIndices;
  }, [flatWords, sentenceEndGlobalIndices]);

  const scrollToNextSentenceAfter = useCallback((globalWordIndex: number) => {
    const ends = sentenceEndGlobalIndexRef.current;
    const sentenceIndex = ends.findIndex((end) => end >= globalWordIndex);
    if (sentenceIndex < 0) {
      console.log('[Voice] scrollToNextSentenceAfter: no sentence for index', globalWordIndex);
      return;
    }
    const nextIdx = sentenceIndex + 1;
    const el = sentenceRefs.current[nextIdx];
    console.log('[Voice] scrollToNextSentenceAfter', { globalWordIndex, sentenceIndex, nextIdx, hasElement: !!el });
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  useEffect(() => {
    if (mode !== 'auto' || !isPlaying || !scrollRef.current) return;

    const scroll = (timestamp: number) => {
      if (!lastTimeRef.current) lastTimeRef.current = timestamp;
      const delta = timestamp - lastTimeRef.current;
      
      if (delta > 16 && scrollRef.current) {
        const pixelsPerFrame = (speed / 100) * 2;
        scrollRef.current.scrollTop += pixelsPerFrame;
        lastTimeRef.current = timestamp;
      }

      animationRef.current = requestAnimationFrame(scroll);
    };

    animationRef.current = requestAnimationFrame(scroll);

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [mode, isPlaying, speed]);

  const togglePlay = useCallback(() => {
    setIsPlaying(prev => {
      lastTimeRef.current = 0;
      console.log('[Voice] togglePlay', { mode, wasPlaying: prev, willBePlaying: !prev });
      return !prev;
    });
  }, [mode]);

  const reset = () => {
    setIsPlaying(false);
    setElapsedTime(0);
    setSpokenWordCount(0);
    setVoiceError(null);
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
  };

  useEffect(() => {
    if (isPlaying && mode === 'auto') {
      timerRef.current = setInterval(() => {
        setElapsedTime(prev => prev + 1);
      }, 1000);
    } else {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    }

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    };
  }, [isPlaying, mode]);

  useEffect(() => {
    console.log('[Voice] effect run', { mode, isPlaying, VOICE_SUPPORTED, flatWordsLength: flatWords.length });
    if (mode !== 'voice' || !isPlaying || !VOICE_SUPPORTED || flatWords.length === 0) {
      console.log('[Voice] skipping start — will stop if was running', { mode, isPlaying, VOICE_SUPPORTED, flatWordsLength: flatWords.length });
      if (recognitionRef.current) {
        try {
          recognitionRef.current.stop();
        } catch {
          /* ignore */
        }
        recognitionRef.current = null;
      }
      return;
    }

    const SR = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!SR) {
      console.warn('[Voice] SpeechRecognition constructor not found');
      return;
    }

    const recognition = new SR() as SpeechRecognition;
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.lang = 'en-US';
    recognitionRef.current = recognition;
    fatalErrorRef.current = false;
    console.log('[Voice] recognition created, starting…', { totalWords: flatWords.length, sentenceEnds: sentenceEndGlobalIndices });

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      const scriptWords = scriptWordsRef.current;
      if (scriptWords.length === 0) return;
      let fullTranscript = '';
      for (let i = 0; i < event.results.length; i++) {
        const r = event.results[i];
        if (r.isFinal && r.length > 0) {
          fullTranscript += (r[0] as { transcript: string }).transcript + ' ';
        }
      }
      const text = fullTranscript.trim();
      if (!text) return;
      const spoken = text.split(/\s+/).map((w) => normalizeWord(w)).filter(Boolean);
      let idx = 0;
      for (const word of spoken) {
        if (idx >= scriptWords.length) break;
        if (normalizeWord(scriptWords[idx]) === word) idx += 1;
      }
      const ends = sentenceEndGlobalIndexRef.current;
      const isSentenceEnd = ends.indexOf(idx - 1) >= 0;
      console.log('[Voice] onresult', {
        transcript: text,
        spokenTokens: spoken.length,
        matchedWordCount: idx,
        scriptWordsSample: scriptWords.slice(0, 8),
        isSentenceEnd,
      });
      setSpokenWordCount((current) => {
        if (idx > current && isSentenceEnd) {
          console.log('[Voice] sentence complete, scrolling to next', { lastSpokenIndex: idx - 1 });
          setTimeout(() => scrollToNextSentenceAfter(idx - 1), 50);
        }
        return idx;
      });
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      console.log('[Voice] onerror', { error: event.error, message: event.message });
      if (event.error === 'not-allowed') {
        setVoiceError('Microphone access denied');
        setIsPlaying(false);
      } else if (event.error === 'network') {
        fatalErrorRef.current = true;
        setVoiceError(
          "Speech service unreachable. In Chrome this often means an ad blocker or privacy extension is blocking it. Try a private window, disable extensions, or use another browser (e.g. Safari uses on-device recognition)."
        );
        setIsPlaying(false);
      } else if (event.error === 'no-speech') {
        /* ignore — safe to restart on onend */
      } else {
        fatalErrorRef.current = true;
        setVoiceError(event.error ?? 'Speech recognition error');
        setIsPlaying(false);
      }
    };

    recognition.onend = () => {
      console.log('[Voice] onend', { stillActive: recognitionRef.current === recognition, hadFatalError: fatalErrorRef.current });
      if (fatalErrorRef.current) return;
      if (recognitionRef.current === recognition && mode === 'voice' && isPlaying) {
        try {
          recognition.start();
          console.log('[Voice] restarted after onend');
        } catch {
          /* ignore */
        }
      }
    };

    setVoiceError(null);
    try {
      recognition.start();
      console.log('[Voice] recognition.start() called');
    } catch (e) {
      console.error('[Voice] recognition.start() threw', e);
      setVoiceError(e instanceof Error ? e.message : 'Could not start microphone');
    }

    return () => {
      console.log('[Voice] cleanup — stopping recognition');
      try {
        recognition.stop();
      } catch {
        /* ignore */
      }
      if (recognitionRef.current === recognition) {
        recognitionRef.current = null;
      }
    };
  }, [mode, isPlaying, flatWords.length, scrollToNextSentenceAfter]);

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const handleKeyPress = useCallback((e: KeyboardEvent) => {
    if (e.code === 'Space' && content) {
      e.preventDefault();
      togglePlay();
    } else if (e.code === 'Escape') {
      setShowSettings(prev => !prev);
    } else if (e.code === 'ArrowLeft' && content) {
      e.preventDefault();
      setSpeed(prev => Math.max(10, prev - 5));
    } else if (e.code === 'ArrowRight' && content) {
      e.preventDefault();
      setSpeed(prev => Math.min(200, prev + 5));
    } else if (e.code === 'ArrowUp' && content) {
      e.preventDefault();
      setFontSize(prev => Math.min(120, prev + 4));
    } else if (e.code === 'ArrowDown' && content) {
      e.preventDefault();
      setFontSize(prev => Math.max(24, prev - 4));
    }
  }, [content, togglePlay]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyPress as EventListener);
    return () => window.removeEventListener('keydown', handleKeyPress as EventListener);
  }, [handleKeyPress]);

  const loadContent = () => {
    if (textInput.trim()) {
      setContent(textInput);
      setSpokenWordCount(0);
      setShowSettings(false);
    }
  };

  if (!content) {
    return (
      <div className="min-h-screen bg-neutral-900 flex items-center justify-center p-8">
        <div className="max-w-4xl w-full">
          <h1 className="text-4xl font-bold text-neutral-100 mb-8 text-center">TELEPROMPTER</h1>
          
          <textarea
            value={textInput}
            onChange={(e) => setTextInput(e.target.value)}
            placeholder="Paste your text here..."
            className="w-full h-96 px-4 py-3 bg-neutral-700 text-neutral-100 placeholder-neutral-400 border border-neutral-600 focus:outline-none focus:border-neutral-400 resize-none text-lg"
          />

          <button
            onClick={loadContent}
            disabled={!textInput.trim()}
            className="w-full bg-white text-black font-bold py-4 mt-4 disabled:opacity-30 disabled:bg-neutral-600 hover:bg-neutral-100"
          >
            START
          </button>

          <div className="mt-8 text-neutral-400 text-sm text-center space-y-2">
            <p>SPACE = play/pause • ESC = settings • ← → = speed • ↑ ↓ = font size</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative min-h-screen bg-black overflow-hidden">
      {showSettings && (
        <div className="absolute top-0 left-0 right-0 bg-neutral-900 z-20 p-8 border-b border-neutral-700">
          <div className="max-w-4xl mx-auto space-y-6">
            <div className="flex justify-between items-center mb-8">
              <h2 className="text-2xl font-bold text-neutral-100">SETTINGS</h2>
              <button
                onClick={() => setShowSettings(false)}
                className="text-neutral-400 hover:text-neutral-100 text-3xl"
              >
                ×
              </button>
            </div>

            <div className="space-y-6">
              {VOICE_SUPPORTED && (
                <div>
                  <label className="block text-neutral-300 mb-2 font-bold">MODE</label>
                  <span className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => { setMode('auto'); setSpokenWordCount(0); }}
                      className={`px-4 py-2 text-sm font-bold ${mode === 'auto' ? 'bg-white text-black' : 'bg-neutral-700 text-neutral-300 hover:bg-neutral-600'}`}
                    >
                      Auto
                    </button>
                    <button
                      type="button"
                      onClick={() => { setMode('voice'); setIsPlaying(false); setSpokenWordCount(0); setVoiceError(null); }}
                      className={`px-4 py-2 text-sm font-bold ${mode === 'voice' ? 'bg-white text-black' : 'bg-neutral-700 text-neutral-300 hover:bg-neutral-600'}`}
                    >
                      Voice
                    </button>
                  </span>
                </div>
              )}

              <div>
                <label className="block text-neutral-300 mb-2 font-bold">SPEED: {speed}%</label>
                <input
                  type="range"
                  min="10"
                  max="200"
                  value={speed}
                  onChange={(e) => setSpeed(Number(e.target.value))}
                  className="w-full h-1 bg-neutral-600 appearance-none"
                  style={{accentColor: '#a3a3a3'}}
                />
              </div>

              <div>
                <label className="block text-neutral-300 mb-2 font-bold">FONT SIZE: {fontSize}px</label>
                <input
                  type="range"
                  min="24"
                  max="120"
                  value={fontSize}
                  onChange={(e) => setFontSize(Number(e.target.value))}
                  className="w-full h-1 bg-neutral-600 appearance-none"
                  style={{accentColor: '#a3a3a3'}}
                />
              </div>

              <div>
                <label className="block text-neutral-300 mb-2 font-bold">LINE HEIGHT: {lineHeight}</label>
                <input
                  type="range"
                  min="1"
                  max="2.5"
                  step="0.1"
                  value={lineHeight}
                  onChange={(e) => setLineHeight(Number(e.target.value))}
                  className="w-full h-1 bg-neutral-600 appearance-none"
                  style={{accentColor: '#a3a3a3'}}
                />
              </div>

            </div>

            <button
              onClick={() => {
                setContent('');
                setTextInput('');
                setShowSettings(false);
              }}
              className="bg-neutral-700 text-neutral-200 px-6 py-2 font-bold hover:bg-neutral-600 mt-4"
            >
              NEW TEXT
            </button>
          </div>
        </div>
      )}

      {voiceError && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-30 bg-red-900/90 text-white px-4 py-2 rounded font-medium text-sm flex items-center gap-2">
          <span>{voiceError}</span>
          <button type="button" onClick={() => setVoiceError(null)} aria-label="Dismiss">×</button>
        </div>
      )}

      <div className="absolute bottom-0 left-0 right-0 bg-neutral-900 z-10 py-4 px-8 border-t border-neutral-700">
        <div className="flex items-center justify-between">
          <div className="text-neutral-400 font-mono text-lg">
            {speed}% • {fontSize}px
          </div>

          <div className="flex items-center gap-4">
            <button
              onClick={reset}
              className="bg-neutral-700 text-neutral-200 w-16 h-16 font-bold text-xl hover:bg-neutral-600 flex items-center justify-center"
            >
              <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46A7.93 7.93 0 0 0 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74A7.93 7.93 0 0 0 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/>
              </svg>
            </button>

            <button
              onClick={togglePlay}
              className="bg-white text-black w-16 h-16 font-bold text-xl hover:bg-neutral-200 flex items-center justify-center"
            >
              {isPlaying ? (
                <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>
                </svg>
              ) : (
                <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M8 5v14l11-7z"/>
                </svg>
              )}
            </button>

            <button
              onClick={() => setShowSettings(!showSettings)}
              className="bg-neutral-700 text-neutral-200 w-16 h-16 font-bold text-xl hover:bg-neutral-600 flex items-center justify-center"
            >
              <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 15.5A3.5 3.5 0 0 1 8.5 12 3.5 3.5 0 0 1 12 8.5a3.5 3.5 0 0 1 3.5 3.5 3.5 3.5 0 0 1-3.5 3.5m7.43-2.53c.04-.32.07-.64.07-.97 0-.33-.03-.66-.07-1l2.11-1.63c.19-.15.24-.42.12-.64l-2-3.46c-.12-.22-.39-.31-.61-.22l-2.49 1c-.52-.39-1.06-.73-1.69-.98l-.37-2.65A.506.506 0 0 0 14 2h-4c-.25 0-.46.18-.5.42l-.37 2.65c-.63.25-1.17.59-1.69.98l-2.49-1c-.22-.09-.49 0-.61.22l-2 3.46c-.13.22-.07.49.12.64L4.57 11c-.04.34-.07.67-.07 1 0 .33.03.65.07.97l-2.11 1.66c-.19.15-.25.42-.12.64l2 3.46c.12.22.39.3.61.22l2.49-1.01c.52.4 1.06.74 1.69.99l.37 2.65c.04.24.25.42.5.42h4c.25 0 .46-.18.5-.42l.37-2.65c.63-.26 1.17-.59 1.69-.99l2.49 1.01c.22.08.49 0 .61-.22l2-3.46c.12-.22.07-.49-.12-.64l-2.11-1.66Z"/>
              </svg>
            </button>
          </div>

          <div className="text-neutral-400 font-mono text-lg">
            {formatTime(elapsedTime)}
          </div>
        </div>
      </div>

      <div
        ref={scrollRef}
        className="h-screen overflow-y-scroll scrollbar-hide pb-32"
      >
        <div className="max-w-4xl mx-auto px-8 pt-32">
          <div
            className="text-neutral-100 whitespace-pre-wrap font-sans"
            style={{
              fontSize: `${fontSize}px`,
              lineHeight: lineHeight,
            }}
          >
            {mode === 'voice' && sentences.length > 0 ? (
              <>
                {sentences.map((sentence, si) => {
                  let globalIdx = 0;
                  for (let i = 0; i < si; i++) globalIdx += sentences[i].words.length;
                  const tokens = sentence.raw.split(/(\s+)/);
                  let wordIdx = 0;
                  return (
                    <span
                      key={si}
                      ref={(el) => {
                        sentenceRefs.current[si] = el;
                      }}
                      style={{ display: 'inline' }}
                    >
                      {tokens.map((token, ti) => {
                        const isWord = /\S/.test(token);
                        const g = globalIdx + wordIdx;
                        if (isWord) wordIdx += 1;
                        return isWord ? (
                          <span
                            key={`${si}-${ti}`}
                            style={{ opacity: g < spokenWordCount ? 0.2 : 1 }}
                            aria-hidden
                          >
                            {token}
                          </span>
                        ) : (
                          <span key={`${si}-${ti}`}>{token}</span>
                        );
                      })}
                      {separators[si] != null ? separators[si] : null}
                    </span>
                  );
                })}
              </>
            ) : (
              content
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
