import React, { useEffect, useRef, useState } from 'react';
import { Pose, Results } from '@mediapipe/pose';

export interface KeyframeData {
  url: string;
  score: number;
  timestamp: string;
  frameIndexInShot: number;
  shotIndex: number;
  poseResults?: Results;
}

export interface ShotData {
  id: number;
  startTime: number;
  endTime: number;
  bestFrame: KeyframeData | null;
}

export const usePoseAnalysis = () => {
  const poseRef = useRef<Pose | null>(null);

  useEffect(() => {
    poseRef.current = new Pose({
      locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}`,
    });

    poseRef.current.setOptions({
      modelComplexity: 1,
      smoothLandmarks: true,
      enableSegmentation: false,
      minDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
  }, []);

  const analyzeFrame = async (imageUrl: string): Promise<Results> => {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = async () => {
        if (!poseRef.current) return reject("Pose not initialized");
        
        poseRef.current.onResults((results) => {
          resolve(results);
        });
        
        await poseRef.current.send({ image: img });
      };
      img.onerror = reject;
      img.src = imageUrl;
    });
  };

  const calculateScore = (results: Results) => {
    if (!results.poseLandmarks) return 0;

    // 1. Number of keypoints with high confidence
    const visiblePoints = results.poseLandmarks.filter(p => p.visibility && p.visibility > 0.5).length;

    // 2. Bounding box area
    const xCoords = results.poseLandmarks.map(p => p.x);
    const yCoords = results.poseLandmarks.map(p => p.y);
    const width = Math.max(...xCoords) - Math.min(...xCoords);
    const height = Math.max(...yCoords) - Math.min(...yCoords);
    const area = width * height;

    // 3. Average confidence
    const avgConfidence = results.poseLandmarks.reduce((acc, p) => acc + (p.visibility || 0), 0) / results.poseLandmarks.length;

    return (visiblePoints * 10) + (area * 100) + (avgConfidence * 50);
  };

  return { analyzeFrame, calculateScore };
};
