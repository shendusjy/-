import React, { useState, useCallback, useEffect } from 'react';
import { 
  Video, 
  User, 
  Layers, 
  Upload, 
  Play, 
  CheckCircle2, 
  ChevronRight, 
  Image as ImageIcon,
  Loader2,
  Download,
  Maximize2,
  Zap
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { useDropzone } from 'react-dropzone';
import { usePoseAnalysis, KeyframeData, ShotData } from './hooks/usePoseAnalysis';
import { generateThreeView, synthesizeReplacement } from './services/geminiService';

type Tab = 'video' | 'character' | 'synthesis';

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>('video');
  const [apiKeySelected, setApiKeySelected] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisStatus, setAnalysisStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [outputResolution, setOutputResolution] = useState<"1K" | "2K" | "4K">("1K");

  // Module 1 State
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [shots, setShots] = useState<ShotData[]>([]);
  const [selectedShotIds, setSelectedShotIds] = useState<number[]>([]);
  const { analyzeFrame, calculateScore } = usePoseAnalysis();

  // Module 2 State
  const [charRef, setCharRef] = useState<string | null>(null);
  const [threeView, setThreeView] = useState<string | null>(null);
  const [isRealistic, setIsRealistic] = useState(false);
  const [charPrompt, setCharPrompt] = useState("根据图像中的人物，重新生成一张有正面、侧面、背面的三视角图像");

  // Module 3 State
  const [synthesizedFrames, setSynthesizedFrames] = useState<string[]>([]);
  const [manualCharAsset, setManualCharAsset] = useState<string | null>(null);

  useEffect(() => {
    const checkKey = async () => {
      if (typeof window.aistudio !== 'undefined') {
        const hasKey = await window.aistudio.hasSelectedApiKey();
        setApiKeySelected(hasKey);
      }
    };
    checkKey();
  }, []);

  const handleOpenKeySelector = async () => {
    if (typeof window.aistudio !== 'undefined') {
      await window.aistudio.openSelectKey();
      setApiKeySelected(true);
    }
  };

  const onVideoDrop = useCallback((acceptedFiles: File[]) => {
    const file = acceptedFiles[0];
    setVideoFile(file);
    setVideoUrl(URL.createObjectURL(file));
    setShots([]);
  }, []);

  const { getRootProps: getVideoProps, getInputProps: getVideoInputProps } = useDropzone({
    onDrop: onVideoDrop,
    accept: { 'video/*': ['.mp4', '.mov'] },
    multiple: false
  } as any);

  const extractShotsAndKeyframes = async (file: File): Promise<ShotData[]> => {
    return new Promise((resolve) => {
      const video = document.createElement('video');
      video.preload = 'auto';
      video.src = URL.createObjectURL(file);
      video.muted = true;

      const highResCanvas = document.createElement('canvas');
      const hCtx = highResCanvas.getContext('2d', { willReadFrequently: true });

      const allFrames: { url: string, time: number, score: number, results: any, frameIdx: number }[] = [];
      let fps = 30; // Default fallback

      video.onloadedmetadata = async () => {
        // Try to detect FPS using requestVideoFrameCallback if available
        if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
          const detectFPS = (): Promise<number> => {
            return new Promise((res) => {
              let frameCount = 0;
              let startTime = -1;
              const callback = (now: number, metadata: any) => {
                if (startTime === -1) startTime = metadata.presentationTime;
                frameCount++;
                if (frameCount < 10 && metadata.presentationTime - startTime < 0.5) {
                  (video as any).requestVideoFrameCallback(callback);
                } else {
                  const detected = Math.round(frameCount / (metadata.presentationTime - startTime));
                  res(detected > 0 ? detected : 30);
                }
              };
              (video as any).requestVideoFrameCallback(callback);
              video.play();
            });
          };
          fps = await detectFPS();
          video.pause();
        }

        // High res for keyframe extraction and display
        const hWidth = 1280;
        const hHeight = 720;
        highResCanvas.width = hWidth;
        highResCanvas.height = hHeight;
        
        const duration = video.duration;
        const sampleInterval = 0.2; // 5 FPS sampling
        let currentTime = 0;

        const processNext = async () => {
          if (currentTime <= duration) {
            video.currentTime = currentTime;
          } else {
            // Sort all frames by score and take top 12
            const topFrames = [...allFrames]
              .sort((a, b) => b.score - a.score)
              .slice(0, 12)
              .sort((a, b) => a.time - b.time); // Re-sort by time for display

            const results: ShotData[] = topFrames.map((frame, idx) => ({
              id: idx + 1,
              startTime: frame.time,
              endTime: frame.time,
              bestFrame: {
                url: frame.url,
                score: frame.score,
                timestamp: `${Math.floor(frame.time / 60)}:${Math.floor(frame.time % 60).toString().padStart(2, '0')}`,
                frameIndexInShot: frame.frameIdx, // This is now the global absolute frame index
                shotIndex: idx + 1,
                poseResults: frame.results
              }
            }));

            video.remove();
            resolve(results);
          }
        };

        video.onseeked = async () => {
          if (hCtx) {
            hCtx.drawImage(video, 0, 0, hWidth, hHeight);
            
            const frameUrl = highResCanvas.toDataURL('image/jpeg', 0.8);
            try {
              const results = await analyzeFrame(frameUrl);
              const score = calculateScore(results);
              
              // Calculate absolute frame index based on detected FPS
              const absoluteFrameIdx = Math.round(currentTime * fps);

              allFrames.push({ 
                url: frameUrl, 
                time: currentTime, 
                score, 
                results,
                frameIdx: absoluteFrameIdx
              });
            } catch (e) {
              console.error("Pose analysis failed", e);
            }

            currentTime += sampleInterval;
            
            setAnalysisStatus(`Analyzing: ${Math.round((currentTime / duration) * 100)}% (Frames: ${allFrames.length}, FPS: ${fps})`);
            processNext();
          }
        };

        processNext();
      };
    });
  };

  const processVideo = async () => {
    if (!videoFile) return;
    setIsAnalyzing(true);
    setAnalysisStatus('Analyzing poses and identifying keyframes...');
    
    try {
      const detectedKeyframes = await extractShotsAndKeyframes(videoFile);
      setShots(detectedKeyframes);
      setAnalysisStatus('Analysis complete!');
      
      // Background upload
      const formData = new FormData();
      formData.append('video', videoFile);
      fetch('/api/upload-video', { method: 'POST', body: formData }).catch(() => {});

    } catch (error: any) {
      console.error(error);
      alert("Analysis failed: " + error.message);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const onCharDrop = useCallback((acceptedFiles: File[]) => {
    const reader = new FileReader();
    reader.onload = () => setCharRef(reader.result as string);
    reader.readAsDataURL(acceptedFiles[0]);
  }, []);

  const { getRootProps: getCharProps, getInputProps: getCharInputProps } = useDropzone({
    onDrop: onCharDrop,
    accept: { 'image/*': ['.png', '.jpg', '.jpeg'] },
    multiple: false
  } as any);

  const onManualCharDrop = useCallback((acceptedFiles: File[]) => {
    const reader = new FileReader();
    reader.onload = () => setManualCharAsset(reader.result as string);
    reader.readAsDataURL(acceptedFiles[0]);
  }, []);

  const { getRootProps: getManualCharProps, getInputProps: getManualCharInputProps } = useDropzone({
    onDrop: onManualCharDrop,
    accept: { 'image/*': ['.png', '.jpg', '.jpeg'] },
    multiple: false
  } as any);

  const toggleShotSelection = (id: number) => {
    setSelectedShotIds(prev => 
      prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]
    );
  };

  const handleGenerateThreeView = async () => {
    if (!charRef) return;
    setIsLoading(true);
    setError(null);
    try {
      const result = await generateThreeView(charRef, charPrompt, outputResolution);
      setThreeView(result);
    } catch (err: any) {
      console.error(err);
      if (err.message?.includes("Requested entity was not found")) {
        setApiKeySelected(false);
        setError("API Key error: Requested entity was not found. Please re-select your API key from a paid project.");
      } else {
        setError(err.message || "Failed to generate character assets. Please check your API key.");
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleBatchSynthesis = async () => {
    const activeCharAsset = manualCharAsset || threeView;
    if (!activeCharAsset || selectedShotIds.length === 0) return;
    setIsLoading(true);
    setError(null);
    try {
      const results = [];
      const selectedShots = shots.filter(s => selectedShotIds.includes(s.id));
      
      for (const shot of selectedShots) {
        if (shot.bestFrame) {
          const res = await synthesizeReplacement(shot.bestFrame.url, activeCharAsset, outputResolution);
          results.push(res);
        }
      }
      setSynthesizedFrames(results);
    } catch (err: any) {
      console.error(err);
      if (err.message?.includes("Requested entity was not found")) {
        setApiKeySelected(false);
        setError("API Key error: Requested entity was not found. Please re-select your API key from a paid project.");
      } else {
        setError(err.message || "Synthesis failed. Please check your API key.");
      }
    } finally {
      setIsLoading(false);
    }
  };

  if (!apiKeySelected) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#0a0a0a] p-4">
        <div className="max-w-md w-full glass p-8 rounded-2xl text-center space-y-6">
          <div className="w-16 h-16 bg-emerald-500/20 rounded-full flex items-center justify-center mx-auto">
            <Zap className="w-8 h-8 text-emerald-500" />
          </div>
          <h1 className="text-2xl font-bold">API Key Required</h1>
          <p className="text-zinc-400">
            This application uses high-quality Gemini models. Please select your API key to continue.
          </p>
          <button onClick={handleOpenKeySelector} className="btn-primary w-full justify-center py-3">
            Select API Key
          </button>
          <p className="text-xs text-zinc-500">
            Requires a paid Google Cloud project. <a href="https://ai.google.dev/gemini-api/docs/billing" target="_blank" className="underline">Billing Info</a>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-[#0a0a0a] overflow-hidden">
      {/* Sidebar */}
      <aside className="w-64 border-r border-white/5 bg-black/40 flex flex-col">
        <div className="p-6">
          <div className="flex items-center gap-3 mb-8">
            <div className="w-8 h-8 bg-emerald-600 rounded-lg flex items-center justify-center">
              <Layers className="w-5 h-5 text-white" />
            </div>
            <span className="font-bold text-sm tracking-tight text-white uppercase">Ref-Frame Gen</span>
          </div>

          <nav className="space-y-2">
            <SidebarItem 
              icon={<Video className="w-4 h-4" />} 
              label="Video Intelligence" 
              active={activeTab === 'video'} 
              onClick={() => setActiveTab('video')}
            />
            <SidebarItem 
              icon={<User className="w-4 h-4" />} 
              label="Character Studio" 
              active={activeTab === 'character'} 
              onClick={() => setActiveTab('character')}
            />
            <SidebarItem 
              icon={<Zap className="w-4 h-4" />} 
              label="Batch Synthesis" 
              active={activeTab === 'synthesis'} 
              onClick={() => setActiveTab('synthesis')}
            />
          </nav>
        </div>

        <div className="mt-auto p-6 border-t border-white/5 space-y-4">
          {!apiKeySelected && (
            <button 
              onClick={handleOpenKeySelector}
              className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-amber-500/10 border border-amber-500/20 rounded-lg text-amber-500 text-xs font-medium hover:bg-amber-500/20 transition-all"
            >
              <Zap className="w-4 h-4" />
              Connect API Key
            </button>
          )}
          <div className="flex items-center gap-3 text-xs text-zinc-500">
            <div className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse" />
            AI Engine Ready
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-y-auto relative">
        <AnimatePresence mode="wait">
          {activeTab === 'video' && (
            <motion.div 
              key="video"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="p-8 max-w-6xl mx-auto space-y-8"
            >
              <header>
                <h2 className="text-3xl font-bold text-white mb-2">Video Intelligence</h2>
                <p className="text-zinc-400">Upload your video to extract the most information-dense keyframes.</p>
              </header>

              <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                <div className="lg:col-span-2 space-y-6">
                  <div {...getVideoProps()} className={`border-2 border-dashed rounded-2xl p-12 text-center transition-colors cursor-pointer ${videoFile ? 'border-emerald-500/50 bg-emerald-500/5' : 'border-white/10 hover:border-white/20'}`}>
                    <input {...getVideoInputProps()} />
                    <Upload className="w-12 h-12 text-zinc-500 mx-auto mb-4" />
                    {videoFile ? (
                      <div className="space-y-4">
                        {videoUrl && (
                          <div className="aspect-video rounded-lg overflow-hidden border border-white/10">
                            <video src={videoUrl} className="w-full h-full object-cover" />
                          </div>
                        )}
                        <div className="space-y-1">
                          <p className="text-white font-medium">{videoFile.name}</p>
                          <p className="text-sm text-zinc-500">{(videoFile.size / 1024 / 1024).toFixed(2)} MB</p>
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <p className="text-white font-medium">Click or drag video to upload</p>
                        <p className="text-sm text-zinc-500">MP4, MOV supported (Max 50MB)</p>
                      </div>
                    )}
                  </div>

                  {videoFile && (
                    <div className="space-y-4">
                      <button 
                        onClick={processVideo} 
                        disabled={isAnalyzing}
                        className="btn-primary w-full py-4 justify-center text-lg"
                      >
                        {isAnalyzing ? (
                          <div className="flex items-center gap-3">
                            <Loader2 className="w-6 h-6 animate-spin" />
                            <span>{analysisStatus}</span>
                          </div>
                        ) : (
                          <><Play className="w-5 h-5" /> Start Analysis</>
                        )}
                      </button>
                      
                      {isAnalyzing && (
                        <div className="w-full bg-zinc-800 h-1.5 rounded-full overflow-hidden">
                          <motion.div 
                            className="h-full bg-emerald-500"
                            initial={{ width: "0%" }}
                            animate={{ width: "100%" }}
                            transition={{ duration: 10, ease: "linear" }}
                          />
                        </div>
                      )}
                    </div>
                  )}
                </div>

                <div className="glass rounded-2xl p-6 space-y-4">
                  <h3 className="font-semibold text-white flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                    Analysis Logic
                  </h3>
                  <ul className="space-y-3 text-sm text-zinc-400">
                    <li className="flex gap-3">
                      <span className="text-emerald-500 font-mono">01</span>
                      MediaPipe Pose estimates skeletal data for every frame.
                    </li>
                    <li className="flex gap-3">
                      <span className="text-emerald-500 font-mono">02</span>
                      Scoring based on keypoint count, bbox area, and confidence.
                    </li>
                    <li className="flex gap-3">
                      <span className="text-emerald-500 font-mono">03</span>
                      Top-scoring frames are identified as keyframes.
                    </li>
                  </ul>
                </div>
              </div>

              {shots.length > 0 && (
                <div className="space-y-6">
                  <div className="flex items-center justify-between">
                    <h3 className="text-xl font-bold text-white">Identified Keyframes</h3>
                    <div className="flex items-center gap-4">
                      <div className="flex bg-zinc-900 rounded-lg p-1 border border-white/5">
                        {(["1K", "2K", "4K"] as const).map((res) => (
                          <button
                            key={res}
                            onClick={() => setOutputResolution(res)}
                            className={`px-3 py-1 text-xs font-mono rounded-md transition-colors ${outputResolution === res ? 'bg-emerald-500 text-white' : 'text-zinc-500 hover:text-zinc-300'}`}
                          >
                            {res}
                          </button>
                        ))}
                      </div>
                      <span className="text-xs text-zinc-500 font-mono">{shots.length} KEYFRAMES IDENTIFIED</span>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {shots.map((shot, i) => (
                      <div 
                        key={i} 
                        onClick={() => toggleShotSelection(shot.id)}
                        className={`glass rounded-2xl overflow-hidden flex flex-col cursor-pointer transition-all border-2 ${selectedShotIds.includes(shot.id) ? 'border-emerald-500 ring-4 ring-emerald-500/20' : 'border-transparent'}`}
                      >
                        <div className="p-4 border-b border-white/5 flex justify-between items-center bg-white/5">
                          <div className="flex items-center gap-2">
                            <div className={`w-4 h-4 rounded-full border ${selectedShotIds.includes(shot.id) ? 'bg-emerald-500 border-emerald-500' : 'border-zinc-600'}`}>
                              {selectedShotIds.includes(shot.id) && <CheckCircle2 className="w-4 h-4 text-white" />}
                            </div>
                            <span className="text-xs font-bold text-emerald-500 uppercase tracking-widest">Keyframe {shot.id}</span>
                          </div>
                          <span className="text-[10px] text-zinc-500 font-mono">Time: {shot.startTime.toFixed(1)}s</span>
                        </div>
                        
                        {shot.bestFrame ? (
                          <>
                            <div className="aspect-video relative group">
                              <img src={shot.bestFrame.url} alt={`Keyframe ${shot.id}`} className="w-full h-full object-cover" />
                              <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                                <button className="btn-secondary py-1 text-xs">Select as Ref</button>
                              </div>
                            </div>
                            <div className="p-4 space-y-2">
                              <div className="flex justify-between items-center">
                                <span className="text-xs text-zinc-400">Video Frame Index</span>
                                <span className="text-xs font-mono text-white">Frame #{shot.bestFrame.frameIndexInShot}</span>
                              </div>
                              <div className="flex justify-between items-center">
                                <span className="text-xs text-zinc-400">Pose Score</span>
                                <span className="text-xs font-mono text-emerald-500">{shot.bestFrame.score.toFixed(0)}</span>
                              </div>
                            </div>
                          </>
                        ) : (
                          <div className="aspect-video flex items-center justify-center text-zinc-600 text-xs italic">
                            No keyframe extracted
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </motion.div>
          )}

          {activeTab === 'character' && (
            <motion.div 
              key="character"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="p-8 max-w-6xl mx-auto space-y-8"
            >
              <header>
                <h2 className="text-3xl font-bold text-white mb-2">Character Studio</h2>
                <p className="text-zinc-400">Upload a character reference to generate professional three-view assets.</p>
              </header>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                <div className="space-y-6">
                  <div {...getCharProps()} className={`border-2 border-dashed rounded-2xl p-12 text-center transition-colors cursor-pointer aspect-square flex flex-col items-center justify-center ${charRef ? 'border-emerald-500/50 bg-emerald-500/5' : 'border-white/10 hover:border-white/20'}`}>
                    <input {...getCharInputProps()} />
                    {charRef ? (
                      <img src={charRef} alt="Reference" className="max-h-full rounded-lg" />
                    ) : (
                      <>
                        <ImageIcon className="w-12 h-12 text-zinc-500 mb-4" />
                        <p className="text-white font-medium">Upload Character Reference</p>
                      </>
                    )}
                  </div>

                  <div className="space-y-4">
                    <div className="space-y-2">
                      <label className="text-sm font-medium text-zinc-400">Generation Prompt</label>
                      <textarea 
                        value={charPrompt}
                        onChange={(e) => setCharPrompt(e.target.value)}
                        className="w-full bg-zinc-900 border border-white/10 rounded-xl p-4 text-sm text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/50 min-h-[100px] resize-none"
                        placeholder="Enter prompt for character generation..."
                      />
                    </div>

                    <div className="flex items-center justify-between p-4 glass rounded-xl">
                      <div className="space-y-1">
                        <p className="text-sm font-medium text-white">Realistic Processing</p>
                        <p className="text-xs text-zinc-500">Convert stylized art to photographic textures.</p>
                      </div>
                      <button 
                        onClick={() => setIsRealistic(!isRealistic)}
                        className={`w-12 h-6 rounded-full transition-colors relative ${isRealistic ? 'bg-emerald-600' : 'bg-zinc-700'}`}
                      >
                        <div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-all ${isRealistic ? 'left-7' : 'left-1'}`} />
                      </button>
                    </div>

                    <button 
                      onClick={handleGenerateThreeView}
                      disabled={!charRef || isLoading}
                      className="btn-primary w-full py-4 justify-center"
                    >
                      {isLoading ? <Loader2 className="w-6 h-6 animate-spin" /> : "Generate Three-View Asset"}
                    </button>
                  </div>
                </div>

                <div className="space-y-6">
                  {error && (
                    <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-xl text-red-500 text-sm flex flex-col gap-3">
                      <p>{error}</p>
                      {error.includes("API Key") && (
                        <button 
                          onClick={handleOpenKeySelector}
                          className="btn-primary py-2 text-xs w-fit"
                        >
                          Select API Key
                        </button>
                      )}
                    </div>
                  )}
                  <div className="aspect-square glass rounded-2xl flex items-center justify-center overflow-hidden">
                    {threeView ? (
                      <img src={threeView} alt="Three View" className="w-full h-full object-contain" />
                    ) : (
                      <div className="text-center p-8">
                        <Layers className="w-12 h-12 text-zinc-800 mx-auto mb-4" />
                        <p className="text-zinc-600">Generated asset will appear here</p>
                      </div>
                    )}
                  </div>
                  {threeView && (
                    <div className="flex gap-3">
                      <button className="btn-secondary flex-1 justify-center">
                        <Download className="w-4 h-4" /> Download Asset
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </motion.div>
          )}

          {activeTab === 'synthesis' && (
            <motion.div 
              key="synthesis"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="p-8 max-w-6xl mx-auto space-y-8"
            >
              <header>
                <h2 className="text-3xl font-bold text-white mb-2">Batch Synthesis</h2>
                <p className="text-zinc-400">Combine extracted keyframes with your character assets for final reference frames.</p>
              </header>

              <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                <div className="lg:col-span-1 space-y-6">
                  <div className="glass rounded-2xl p-6 space-y-6">
                    <h3 className="font-bold text-white">Synthesis Queue</h3>
                    <div className="space-y-4">
                      <div className="flex items-center gap-3">
                        <div className="w-12 h-12 rounded bg-zinc-800 flex items-center justify-center overflow-hidden">
                          {selectedShotIds.length > 0 ? (
                            <img src={shots.find(s => s.id === selectedShotIds[0])?.bestFrame?.url} className="w-full h-full object-cover" />
                          ) : (
                            <Video className="w-6 h-6 text-zinc-600" />
                          )}
                        </div>
                        <div className="flex-1">
                          <p className="text-xs text-zinc-400">Source Shots</p>
                          <p className="text-sm font-medium text-white">{selectedShotIds.length} shots selected</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <div className="w-12 h-12 rounded bg-zinc-800 flex items-center justify-center relative group">
                          {manualCharAsset ? (
                            <img src={manualCharAsset} className="w-full h-full object-cover rounded" />
                          ) : threeView ? (
                            <img src={threeView} className="w-full h-full object-cover rounded" />
                          ) : (
                            <User className="w-6 h-6 text-zinc-600" />
                          )}
                          <div {...getManualCharProps()} className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 flex items-center justify-center cursor-pointer transition-opacity rounded">
                            <input {...getManualCharInputProps()} />
                            <Upload className="w-4 h-4 text-white" />
                          </div>
                        </div>
                        <div className="flex-1">
                          <p className="text-xs text-zinc-400">Character Asset</p>
                          <p className="text-sm font-medium text-white">
                            {manualCharAsset ? "Manual Upload" : threeView ? "Generated Asset" : "No asset selected"}
                          </p>
                        </div>
                        {(manualCharAsset || threeView) && (
                          <div {...getManualCharProps()} className="cursor-pointer p-2 hover:bg-white/5 rounded-lg transition-colors">
                            <input {...getManualCharInputProps()} />
                            <ImageIcon className="w-4 h-4 text-zinc-500" />
                          </div>
                        )}
                      </div>
                    </div>

                    <button 
                      onClick={handleBatchSynthesis}
                      disabled={(!threeView && !manualCharAsset) || selectedShotIds.length === 0 || isLoading}
                      className="btn-primary w-full py-4 justify-center"
                    >
                      {isLoading ? <Loader2 className="w-6 h-6 animate-spin" /> : `Start Batch Synthesis (${selectedShotIds.length})`}
                    </button>
                  </div>
                </div>

                <div className="lg:col-span-2 space-y-6">
                  {synthesizedFrames.length > 0 ? (
                    <div className="space-y-8">
                      {synthesizedFrames.map((frame, i) => (
                        <div key={i} className="space-y-3">
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-mono text-zinc-500 uppercase tracking-widest">Comparison Frame {i + 1}</span>
                            <button className="text-emerald-500 text-xs hover:underline">Download Result</button>
                          </div>
                          <div className="grid grid-cols-2 gap-4">
                            <div className="glass rounded-xl overflow-hidden aspect-video relative">
                              {shots.find(s => s.id === selectedShotIds[i])?.bestFrame && (
                                <img src={shots.find(s => s.id === selectedShotIds[i])!.bestFrame!.url} alt="Original" className="w-full h-full object-cover" />
                              )}
                              <span className="absolute top-2 left-2 bg-black/60 px-2 py-1 rounded text-[10px] text-white">ORIGINAL (SHOT {selectedShotIds[i]})</span>
                            </div>
                            <div className="glass rounded-xl overflow-hidden aspect-video relative border-emerald-500/30">
                              <img src={frame} alt="Synthesized" className="w-full h-full object-cover" />
                              <span className="absolute top-2 left-2 bg-emerald-600 px-2 py-1 rounded text-[10px] text-white">SYNTHESIZED</span>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="h-96 glass rounded-2xl flex flex-col items-center justify-center text-center p-12">
                      <Zap className="w-16 h-16 text-zinc-800 mb-6" />
                      <h4 className="text-lg font-medium text-zinc-400 mb-2">Ready for Synthesis</h4>
                      <p className="text-sm text-zinc-600 max-w-xs">
                        Once you start the process, AI will seamlessly replace characters in your keyframes while preserving pose and environment.
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
}

function SidebarItem({ icon, label, active, onClick }: { icon: React.ReactNode, label: string, active: boolean, onClick: () => void }) {
  return (
    <button 
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-all ${active ? 'sidebar-item-active' : 'text-zinc-500 hover:text-zinc-300 hover:bg-white/5'}`}
    >
      {icon}
      {label}
      {active && <ChevronRight className="w-4 h-4 ml-auto" />}
    </button>
  );
}
