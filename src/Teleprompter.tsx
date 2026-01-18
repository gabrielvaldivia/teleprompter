import React, { useState, useEffect, useRef, useCallback } from 'react';

export default function Teleprompter() {
  const [content, setContent] = useState('');
  const [textInput, setTextInput] = useState('');
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState(50);
  const [fontSize, setFontSize] = useState(48);
  const [showSettings, setShowSettings] = useState(false);
  const [mirror, setMirror] = useState(false);
  const [lineHeight, setLineHeight] = useState(1.5);
  const [elapsedTime, setElapsedTime] = useState(0);
  
  const scrollRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const animationRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number>(0);

  useEffect(() => {
    if (!isPlaying || !scrollRef.current) return;

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
  }, [isPlaying, speed]);

  const togglePlay = useCallback(() => {
    setIsPlaying(prev => {
      lastTimeRef.current = 0;
      return !prev;
    });
  }, []);

  const reset = () => {
    setIsPlaying(false);
    setElapsedTime(0);
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
  };

  useEffect(() => {
    if (isPlaying) {
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
  }, [isPlaying]);

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

              <div className="flex items-center gap-3">
                <input
                  type="checkbox"
                  checked={mirror}
                  onChange={(e) => setMirror(e.target.checked)}
                  className="w-5 h-5 accent-neutral-400"
                />
                <label className="text-neutral-300 font-bold">MIRROR MODE</label>
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

      <div className="absolute bottom-0 left-0 right-0 bg-neutral-900 z-10 p-4 border-t border-neutral-700">
        <div className="flex items-center justify-between">
          <div className="text-neutral-400 font-mono text-lg">
            {speed}% • {fontSize}px
          </div>

          <div className="flex items-center gap-4">
            <button
              onClick={reset}
              className="bg-neutral-700 text-neutral-200 w-16 h-16 font-bold text-xl hover:bg-neutral-600"
            >
              ↻
            </button>

            <button
              onClick={togglePlay}
              className="bg-white text-black w-16 h-16 font-bold text-xl hover:bg-neutral-200"
            >
              {isPlaying ? '❚❚' : '▶'}
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
        style={{
          transform: mirror ? 'scaleX(-1)' : 'none',
        }}
      >
        <div className="max-w-4xl mx-auto px-8 pt-32">
          <div
            className="text-neutral-100 whitespace-pre-wrap"
            style={{
              fontSize: `${fontSize}px`,
              lineHeight: lineHeight,
              transform: mirror ? 'scaleX(-1)' : 'none',
            }}
          >
            {content}
          </div>
        </div>
      </div>
    </div>
  );
}
