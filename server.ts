import express from "express";
import { createServer as createViteServer } from "vite";
import multer from "multer";
import path from "path";
import fs from "fs";
import ffmpeg from "fluent-ffmpeg";

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Ensure uploads directory exists
  const uploadDir = path.join(process.cwd(), "uploads");
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
  }

  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, "uploads/");
    },
    filename: (req, file, cb) => {
      cb(null, `${Date.now()}-${file.originalname}`);
    },
  });

  const upload = multer({ 
    storage,
    limits: { fileSize: 50 * 1024 * 1024 } // 50MB limit
  });

  app.use(express.json());

  // Error handling middleware for multer
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ error: `Multer error: ${err.message}` });
    }
    next(err);
  });

  // API Routes
  app.post("/api/upload-video", upload.single("video"), (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }
    res.json({ 
      filename: req.file.filename,
      path: `/uploads/${req.file.filename}`
    });
  });

  // Serve uploaded files
  app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));

  // Extract frames endpoint
  app.post("/api/extract-frames", async (req, res) => {
    try {
      const { filename } = req.body;
      if (!filename) {
        return res.status(400).json({ error: "Filename is required" });
      }

      const videoPath = path.join(process.cwd(), "uploads", filename);
      const outputDirName = `frames-${filename.replace(/\.[^/.]+$/, "")}`;
      const outputDir = path.join(process.cwd(), "uploads", outputDirName);

      if (!fs.existsSync(videoPath)) {
        return res.status(404).json({ error: "Video file not found" });
      }

      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      ffmpeg(videoPath)
        .on("start", (commandLine) => {
          console.log("Spawned Ffmpeg with command: " + commandLine);
        })
        .on("end", () => {
          const frames = fs.readdirSync(outputDir)
            .filter(f => f.endsWith(".jpg"))
            .map(f => `/uploads/${outputDirName}/${f}`);
          res.json({ frames });
        })
        .on("error", (err) => {
          console.error("Ffmpeg error:", err);
          if (!res.headersSent) {
            res.status(500).json({ error: `Failed to extract frames: ${err.message}` });
          }
        })
        .screenshots({
          count: 20,
          folder: outputDir,
          size: "640x?",
          filename: "frame-%i.jpg"
        });
    } catch (error: any) {
      console.error("Extraction endpoint error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(process.cwd(), "dist")));
    app.get("*", (req, res) => {
      res.sendFile(path.join(process.cwd(), "dist", "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
