import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const res = await ai.models.generateContent({
  model: "gemini-2.5-flash",
  contents: "1行だけ自己紹介して。日本語で。",
});

console.log(res.text);
