import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@retrom/ui/components/card";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@retrom/ui/components/tabs";
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
  useCarousel,
} from "@retrom/ui/components/carousel";
import { Image } from "@/lib/utils";
import { cn } from "@retrom/ui/lib/utils";
import { useGameDetail } from "@/providers/game-details";
import { createUrl, usePublicUrl, useApiUrl } from "@/utils/urls";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useUpdateGameMetadata } from "@/mutations/useUpdateGameMetadata";
import { useToast } from "@retrom/ui/hooks/use-toast";

export function Media() {
  const publicUrl = usePublicUrl();
  const apiUrl = useApiUrl();
  const { game, gameMetadata, extraMetadata } = useGameDetail();

  const screenshots = useMemo(() => {
    const localPaths = extraMetadata?.mediaPaths?.screenshotUrls;
    if (localPaths && publicUrl) {
      return localPaths
        .map((path) => createUrl({ path, base: publicUrl })?.href)
        .filter((s) => s !== undefined);
    }

    return gameMetadata?.screenshotUrls ?? [];
  }, [publicUrl, extraMetadata, gameMetadata]);

  const artwork = useMemo(() => {
    const localPaths = extraMetadata?.mediaPaths?.artworkUrls;
    if (localPaths && publicUrl) {
      return localPaths
        .map((path) => createUrl({ path, base: publicUrl })?.href)
        .filter((s) => s !== undefined);
    }

    return gameMetadata?.artworkUrls ?? [];
  }, [publicUrl, extraMetadata, gameMetadata]);

  const themeAudioUrl = useMemo(() => {
    const localPath = (extraMetadata as any)?.mediaPaths?.themeAudioUrl;
    if (localPath && publicUrl) {
      return createUrl({ path: localPath, base: publicUrl })?.href;
    }
    if (publicUrl && game) {
      // Robust fallback using magic base "theme" (no ext). The ThemePlayer will
      // try all possible theme.* exts via <source> elements so whatever yt-dlp wrote
      // (theme.m4a, theme.opus, theme.webm, etc.) will be found and played.
      const possiblePath = `media/games/${game.id}/theme`;
      return createUrl({ path: possiblePath, base: publicUrl })?.href;
    }
    return undefined;
  }, [publicUrl, extraMetadata, game]);

  const playerBackgroundUrl = useMemo(() => {
    const localBg = extraMetadata?.mediaPaths?.backgroundUrl;
    if (localBg && publicUrl) {
      return createUrl({ path: localBg, base: publicUrl })?.href;
    }
    if (gameMetadata?.backgroundUrl) return gameMetadata.backgroundUrl;
    const localCover = extraMetadata?.mediaPaths?.coverUrl;
    if (localCover && publicUrl) {
      return createUrl({ path: localCover, base: publicUrl })?.href;
    }
    return gameMetadata?.coverUrl;
  }, [extraMetadata, publicUrl, gameMetadata]);

  // Upload state and handlers (added back without touching embed logic)
  const updateGameMetadataMutation = useUpdateGameMetadata();
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadCategory, setUploadCategory] = useState<"screenshots" | "artwork" | "videos" | null>(null);

  const triggerUpload = (cat: "screenshots" | "artwork" | "videos") => {
    setUploadCategory(cat);
    if (fileInputRef.current) {
      fileInputRef.current.accept = cat === "videos" ? "video/*,audio/*" : "image/*";
      fileInputRef.current.click();
    }
  };

  const handleFilesSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    const cat = uploadCategory;
    if (!files || !cat || !game) {
      e.target.value = "";
      setUploadCategory(null);
      return;
    }

    const subdir = cat === "screenshots" ? "screenshots" : cat === "artwork" ? "artwork" : "videos";
    const field = cat === "screenshots" ? "screenshotUrls" : cat === "artwork" ? "artworkUrls" : "videoUrls";

    const added: string[] = [];

    try {
      for (const file of Array.from(files)) {
        const ext = file.name.split(".").pop() || "bin";
        const base = file.name.replace(/\.[^/.]+$/, "").replace(/[^a-z0-9_-]/gi, "_");
        const targetPath = `media/games/${game.id}/${subdir}/user-${Date.now()}-${base}.${ext}`;
        const content = new Uint8Array(await file.arrayBuffer());

        const uploadUrl = new URL(`./rest/public/${targetPath}`, apiUrl!).toString();
        const body = JSON.stringify({
          stat: { path: targetPath, node_type: 1 },
          content: Array.from(content),
        });

        const res = await fetch(uploadUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });

        if (res.ok) {
          added.push(targetPath);
        } else {
          throw new Error(`Upload failed for ${file.name}`);
        }
      }

      if (added.length > 0) {
        const currentList = (gameMetadata as any)?.[field] ?? [];
        const updated = {
          gameId: game.id,
          [field]: [...currentList, ...added],
        };
        await updateGameMetadataMutation.mutateAsync({ metadata: [updated as any] });
        toast({
          title: `${added.length} file(s) added`,
          description: `Added to ${cat}`,
        });
      }
    } catch (err) {
      toast({
        title: "Upload failed",
        description: String(err),
        variant: "destructive",
      });
    } finally {
      e.target.value = "";
      setUploadCategory(null);
    }
  };

  if (!gameMetadata) {
    return null;
  }

  const showImages = !!artwork.length;
  const showScreenshots = !!screenshots.length;
  const showVideos = !!gameMetadata?.videoUrls.length;
  const showTheme = showVideos || !!themeAudioUrl; // Theme tab for playing the downloaded theme song on loop (local audio if extracted)

  let tabsShown = 0;
  if (showImages) tabsShown++;
  if (showScreenshots) tabsShown++;
  if (showVideos) tabsShown++;
  if (showTheme) tabsShown++;

  if (tabsShown === 0) {
    return null;
  }

  const defaultTab = showTheme
    ? "theme"
    : showImages
      ? "images"
      : showScreenshots
        ? "screenshots"
        : showVideos
          ? "videos"
          : "none";

  return (
    <Card className="col-span-full">
      <CardHeader>
        <CardTitle>Media</CardTitle>
      </CardHeader>

      <CardContent>
        <Tabs defaultValue={defaultTab}>
          {tabsShown > 1 ? (
            <TabsList className="flex w-full *:w-full">
              {showTheme ? (
                <TabsTrigger value="theme">Theme</TabsTrigger>
              ) : null}
              {showImages ? (
                <TabsTrigger value="images">Images</TabsTrigger>
              ) : null}
              {showScreenshots ? (
                <TabsTrigger value="screenshots">Screenshots</TabsTrigger>
              ) : null}
              {showVideos ? (
                <TabsTrigger value="videos">Videos</TabsTrigger>
              ) : null}
            </TabsList>
          ) : null}

          <TabsContent value="theme">
            <ThemePlayer
              themeUrl={themeAudioUrl}
              backgroundUrl={playerBackgroundUrl}
              youtubeUrl={gameMetadata?.videoUrls?.find((u: string) =>
                /youtube\.com|youtu\.be/.test(u),
              )}
            />
          </TabsContent>

          <TabsContent value="images">
            <ImageCarousel images={artwork} />
          </TabsContent>

          <TabsContent value="screenshots">
            <ImageCarousel images={screenshots} />
          </TabsContent>

          <TabsContent value="videos">
            <VideoCarousel videos={gameMetadata.videoUrls} />
          </TabsContent>

          <TabsContent value="none">
            <div className="w-full aspect-video grid place-items-center">
              <h4 className="text-muted-foreground/50 font-medium text-3xl">
                No media available.
              </h4>
            </div>
          </TabsContent>
        </Tabs>

        {/* Upload section for custom media - does not affect the Videos embeds */}
        <div className="mt-4 pt-4 border-t">
          <div className="text-sm font-medium mb-2">Add your own media</div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="px-3 py-1 text-sm border rounded hover:bg-muted"
              onClick={() => triggerUpload("screenshots")}
            >
              Upload Screenshot
            </button>
            <button
              type="button"
              className="px-3 py-1 text-sm border rounded hover:bg-muted"
              onClick={() => triggerUpload("artwork")}
            >
              Upload Artwork
            </button>
            <button
              type="button"
              className="px-3 py-1 text-sm border rounded hover:bg-muted"
              onClick={() => triggerUpload("videos")}
            >
              Upload Video or Audio
            </button>
          </div>
          <p className="text-[10px] text-muted-foreground mt-1">
            Files are stored with the game. The Videos tab continues to show
            embedded YouTube content unchanged.
          </p>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          multiple
          onChange={handleFilesSelected}
        />
      </CardContent>
    </Card>
  );
}

function ImageCarousel(props: { images: string[] }) {
  const { images } = props;

  return (
    <Carousel className="group">
      <CarouselContent className="h-max">
        {images.map((img, idx) => (
          <CarouselItem key={idx}>
            <div
              className={cn(
                "relative h-full aspect-video rounded-lg overflow-hidden",
                "flex justify-center items-center",
              )}
            >
              <Image
                src={img}
                className="absolute inset-0 blur-3xl z-[-1]"
                alt=""
              />
              <Image src={img} className="max-h-full mx-auto" alt="" />
            </div>
          </CarouselItem>
        ))}
      </CarouselContent>

      {images.length > 1 ? <Controls /> : null}
    </Carousel>
  );
}

function VideoCarousel(props: { videos: string[] }) {
  const { videos } = props;

  return (
    <Carousel className="group" opts={{ inViewThreshold: 0.2 }}>
      <VideoItems videos={videos} />

      {videos.length > 1 ? <Controls /> : null}
    </Carousel>
  );
}

function VideoItems(props: { videos: string[] }) {
  const { videos } = props;
  const [inactive, setInactive] = useState(Array<number>());
  const { api } = useCarousel();

  const handleViewEvent = useCallback((currentApi: typeof api) => {
    const notInView = currentApi?.slidesNotInView();
    if (notInView) {
      setInactive(notInView);
    }
  }, []);

  useLayoutEffect(() => {
    api?.on("slidesInView", handleViewEvent);

    return () => {
      api?.off("slidesInView", handleViewEvent);
    };
  }, [api, handleViewEvent]);

  // Normalize any YouTube URL (watch, youtu.be, shorts, or embed) to a proper embed URL.
  // This makes both IGDB-scraped videos and the soundtrack theme video embed correctly,
  // restoring the simple embedding behavior from the original app (which only had IGDB embed URLs).
  // We convert watch?v= (from the new soundtrack feature) to embed form so they can be iframed.
  const getYoutubeEmbedSrc = (url: string): string => {
    try {
      const parsed = new URL(url);
      const host = parsed.hostname.toLowerCase();
      let id = "";
      if (host.includes("youtu.be")) {
        id = parsed.pathname.split("/").filter(Boolean)[0] || "";
      } else if (
        host.includes("youtube.com") ||
        host.includes("music.youtube.com")
      ) {
        id = parsed.searchParams.get("v") || "";
        if (!id) {
          const parts = parsed.pathname.split("/").filter(Boolean);
          const embedIdx = parts.indexOf("embed");
          if (embedIdx !== -1) id = parts[embedIdx + 1] || "";
          const shortsIdx = parts.indexOf("shorts");
          if (shortsIdx !== -1) id = parts[shortsIdx + 1] || "";
        }
      }
      if (id) {
        return `https://www.youtube.com/embed/${id}`;
      }
    } catch {
      // fall through
    }
    return url;
  };

  const isAudio = (url: string) =>
    /\.(mp3|wav|ogg|opus|m4a|flac|webm|aac)$/i.test(url.split("?")[0] || url);

  return (
    <CarouselContent className="h-max">
      {videos.map((video, idx) => {
        const finalSrc = getYoutubeEmbedSrc(video);
        const isYoutubeEmbed = /youtube(?:-nocookie)?\.com\/embed\//.test(
          finalSrc,
        );
        return (
          <CarouselItem key={idx}>
            {inactive.includes(idx) ? null : isYoutubeEmbed ? (
              <iframe
                // @ts-expect-error -- types out of date
                credentialless="true"
                className="w-full aspect-video rounded-lg"
                src={finalSrc}
              />
            ) : isAudio(finalSrc) ? (
              <div className="w-full aspect-video rounded-lg bg-muted/30 flex items-center justify-center p-4">
                <audio src={finalSrc} controls className="w-full" />
              </div>
            ) : (
              <video
                src={finalSrc}
                controls
                className="w-full aspect-video rounded-lg bg-black"
              />
            )}
          </CarouselItem>
        );
      })}
    </CarouselContent>
  );
}

function Controls() {
  return (
    <div className="group-hover:opacity-100 opacity-0 transition-opacity">
      <CarouselPrevious variant="accent" className="ml-8" />
      <CarouselNext variant="accent" className="mr-8" />
    </div>
  );
}

function ThemePlayer(props: {
  themeUrl?: string;
  backgroundUrl?: string;
  youtubeUrl?: string;
}) {
  const { themeUrl, backgroundUrl, youtubeUrl } = props;

  if (!themeUrl) {
    return (
      <div className="w-full aspect-video rounded-lg bg-muted/30 flex items-center justify-center">
        <div className="text-center">
          <p className="text-muted-foreground">
            No local theme audio extracted yet (run Download Metadata to
            populate).
          </p>
          {youtubeUrl && (
            <a
              href={youtubeUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-accent underline mt-1 inline-block"
            >
              Play the theme on YouTube (in Videos tab too) →
            </a>
          )}
        </div>
      </div>
    );
  }

  const isMagicTheme = !!themeUrl && themeUrl.endsWith("/theme");
  const themeExts = [
    { ext: "m4a", type: "audio/mp4" },
    { ext: "webm", type: "audio/webm" },
    { ext: "opus", type: "audio/ogg" },
    { ext: "ogg", type: "audio/ogg" },
    { ext: "mp3", type: "audio/mpeg" },
    { ext: "flac", type: "audio/flac" },
    { ext: "wav", type: "audio/wav" },
  ];

  return (
    <div
      className="relative w-full aspect-video rounded-lg overflow-hidden bg-black flex items-end"
      style={
        backgroundUrl
          ? {
              backgroundImage: `url(${backgroundUrl})`,
              backgroundSize: "cover",
              backgroundPosition: "center",
            }
          : undefined
      }
    >
      {backgroundUrl && (
        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      )}
      <div className="relative z-10 w-full p-4 space-y-2">
        <div className="flex items-center justify-between text-white/90">
          <div>
            <div className="font-semibold">Theme Music</div>
            <div className="text-xs text-white/70">
              Downloaded theme • loops on this screen
            </div>
          </div>
          {youtubeUrl && (
            <a
              href={youtubeUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs px-3 py-1 rounded bg-secondary text-secondary-foreground hover:bg-secondary/80"
              onClick={(e) => e.stopPropagation()}
            >
              Watch on YouTube
            </a>
          )}
        </div>
        {isMagicTheme ? (
          <audio controls loop className="w-full">
            {themeExts.map(({ ext, type }) => (
              <source key={ext} src={`${themeUrl}.${ext}`} type={type} />
            ))}
          </audio>
        ) : (
          <audio src={themeUrl} controls loop className="w-full" />
        )}
      </div>
    </div>
  );
}
