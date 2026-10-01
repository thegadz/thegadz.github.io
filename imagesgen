// Set the XAI_API_KEY environment variable before running.
import { xai } from "@ai-sdk/xai";
import { experimental_generateVideo as generateVideo } from "ai";

// The SDK submits the request and polls until the video is ready.
const result = await generateVideo({
    model: xai.video("grok-imagine-video-1.5"),
    prompt: {
        text: "add subtle animation",
        image: "https://data.x.ai/imagine-console/video-game-character.jpeg",
    },
    duration: 6,
    providerOptions: {
        xai: { resolution: "720p" },
    },
});

const videoUrl = result.providerMetadata?.xai?.videoUrl;
console.log(videoUrl);
