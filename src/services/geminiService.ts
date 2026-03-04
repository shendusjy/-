import { GoogleGenAI, Modality } from "@google/genai";

export const getAI = () => {
  // Use process.env.API_KEY (from user selection dialog) as primary, 
  // fallback to GEMINI_API_KEY (from environment)
  const apiKey = process.env.API_KEY || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("API Key is not set. Please click 'Connect Gemini API Key' to select a paid project key.");
  }
  return new GoogleGenAI({ apiKey });
};

export const generateThreeView = async (base64Image: string, customPrompt: string, imageSize: "1K" | "2K" | "4K" = "1K") => {
  const ai = getAI();
  const model = "gemini-3-pro-image-preview"; 
  
  let retries = 3;
  let backoffDelay = 2000;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents: {
          parts: [
            { inlineData: { data: base64Image.split(',')[1], mimeType: "image/png" } },
            { text: customPrompt }
          ]
        },
        config: {
          imageConfig: {
            aspectRatio: "16:9",
            imageSize: imageSize
          }
        }
      });

      if (!response.candidates?.[0]?.content?.parts) {
        throw new Error("Invalid response structure");
      }

      for (const part of response.candidates[0].content.parts) {
        if (part.inlineData) {
          return `data:image/png;base64,${part.inlineData.data}`;
        }
      }
      throw new Error("No image part found in response");
    } catch (error: any) {
      const isTransient = error.message?.includes("503") || 
                        error.message?.includes("UNAVAILABLE") || 
                        error.message?.includes("high demand");
      
      if (isTransient && attempt < retries) {
        console.warn(`Generation attempt ${attempt + 1} failed (503). Retrying in ${backoffDelay}ms...`);
        await new Promise(resolve => setTimeout(resolve, backoffDelay));
        backoffDelay *= 2; // Exponential backoff
        continue;
      }
      console.error(`Generation failed final attempt:`, error);
      throw error;
    }
  }
  throw new Error("Generation failed after retries due to high model demand.");
};

export const synthesizeReplacement = async (keyframeBase64: string, characterBase64: string, customPrompt: string, imageSize: "1K" | "2K" | "4K" = "1K") => {
  const ai = getAI();
  const model = "gemini-3-pro-image-preview";
  const prompt = customPrompt || `严格参考 [关键帧图片] 中的人物动作姿态和构图，将人物替换为 [三视图] 中的角色。保持背景光影与 [关键帧图片] 完全一致。高质量，照片级真实感，无缝融合。`;

  let retries = 2;
  let backoffDelay = 3000;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents: {
          parts: [
            { text: "[关键帧图片]:" },
            { inlineData: { data: keyframeBase64.split(',')[1], mimeType: "image/png" } },
            { text: "[三视图]:" },
            { inlineData: { data: characterBase64.split(',')[1], mimeType: "image/png" } },
            { text: prompt }
          ]
        },
        config: {
          imageConfig: {
            aspectRatio: "16:9",
            imageSize: imageSize
          }
        }
      });

      for (const part of response.candidates[0].content.parts) {
        if (part.inlineData) {
          return `data:image/png;base64,${part.inlineData.data}`;
        }
      }
      throw new Error("No image generated");
    } catch (error: any) {
      const isTransient = error.message?.includes("503") || 
                        error.message?.includes("UNAVAILABLE") || 
                        error.message?.includes("high demand");
      
      if (isTransient && attempt < retries) {
        console.warn(`Synthesis attempt ${attempt + 1} failed (503). Retrying in ${backoffDelay}ms...`);
        await new Promise(resolve => setTimeout(resolve, backoffDelay));
        backoffDelay *= 2;
        continue;
      }
      throw error;
    }
  }
  throw new Error("Synthesis failed after retries due to high model demand.");
};
