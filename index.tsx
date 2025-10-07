/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import { GoogleGenAI, Type } from '@google/genai';
import { useState, useCallback, ChangeEvent, DragEvent, useEffect } from 'react';
import ReactDOM from 'react-dom/client';

const FRAME_RATE = 25;

// --- Helper Functions ---

const timecodeToFrames = (tc: string): number => {
  const parts = tc.split(':').map(Number);
  if (parts.length !== 4) return 0;
  const [h, m, s, f] = parts;
  return (h * 3600 + m * 60 + s) * FRAME_RATE + f;
};

const framesToHMS = (totalFrames: number): string => {
  if (isNaN(totalFrames) || totalFrames < 0) return "00:00:00";
  const totalSeconds = Math.round(totalFrames / FRAME_RATE);
  const s = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const m = totalMinutes % 60;
  const h = Math.floor(totalMinutes / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};

const cleanTrackName = (name: string): string => {
  let cleaned = name;
  const proToolsSuffixIndex = cleaned.indexOf('.new.');
  if (proToolsSuffixIndex !== -1) {
    cleaned = cleaned.substring(0, proToolsSuffixIndex);
  }
  const extensions = ['.wav', '.mp3', '.aif', '.aiff'];
  for (const ext of extensions) {
    if (cleaned.toLowerCase().endsWith(ext)) {
      cleaned = cleaned.substring(0, cleaned.length - ext.length);
      break;
    }
  }
  return cleaned.trim();
};

const getBaseTrackName = (name: string): string => {
    // First, perform a general cleanup to remove file extensions and Pro Tools suffixes
    let base = name
        .replace(/\.new\..*/, '')
        .replace(/\.(wav|mp3|aif|aiff)$/i, '')
        .replace(/\.Copy\.\d+/g, '');

    // Patterns for specific versions, stems, or descriptors
    const patternsToRemove = [
        /\s*[\(\[].*?[\)\]]/g, // Anything in parentheses/brackets e.g. (Instrumental), (D)
        /_(INSTRUMENTAL|INST|UNDERSCORE|NO[\s_]?VOX|VOCALS?|REMIX|ALT|LITE|FULL|KEYS|FX|DRUMS|BASS|SFX|CHOIR|PNO|STRINGS|LEAD|MIX|FULLMIX|LITEMIX|DRUMnBASS|BIGnSPARSEmix|STEM|VERSION|EDIT|ATMOS|DRM|GTR|PIANO|SYNTH|STRIP)$/i,
        /_only[a-zA-Z0-9_]+$/i, // Suffixes like _onlyDRUMS, _onlyPULSINGmallets
        /\s+-\s+(Instrumental|Vocal|Remix|Underscore|Lite|Full|Stem|Edit)$/i,
        /v\d+$/i, // Version numbers like v2, v3
        /\b(full|lite|only\w+|alt|stems|drums|bass)\b/i, // Standalone words
    ];

    let previousBase;
    do {
        previousBase = base;
        for (const pattern of patternsToRemove) {
            base = base.replace(pattern, '');
        }
        base = base.replace(/[\W_]+$/, '').trim(); // Remove trailing non-alphanumeric chars
    } while (base !== previousBase);

    return base.trim();
};

const parseMkrTitle = (filename: string): string => {
  // Example: MKR11_COOK_A_BREEZE_811_MS_FULL -> Cook A Breeze 811
  const core = filename
    .replace(/^MKR\d+_/i, '') // Remove prefix e.g., "MKR11_"
    .replace(/_(MS|CT|AA)(_FULL)?$/i, ''); // Remove suffixes e.g., "_MS_FULL" or "_MS"

  return core
    .replace(/_/g, ' ')
    .toLowerCase()
    .split(' ')
    .map(word => {
        // Handle specific acronyms that should be uppercase
        if (word.toUpperCase() === 'POS') return 'POS';
        // Capitalize the first letter of each word
        return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(' ');
};

const formatMkrComposerName = (name: string): string => {
  // Reformats "LastName FirstName" to "FirstName LastName"
  const parts = name.trim().split(/\s+/);
  if (parts.length === 2) {
    return `${parts[1]} ${parts[0]}`;
  }
  return name; // Return as-is if format is not as expected
};


// --- Type Definitions ---

type Clip = {
  startTimeFrames: number;
  endTimeFrames: number;
};

type TrackInfo = {
  originalName: string;
  title: string;
  composers?: string[];
  performers?: string[];
  publisher?: string;
  musicSource: 'Production Music (library)' | 'Commercial Recording' | 'Commissioned';
  catalogueCode?: string;
  trackNo?: string;
  vocalOrInstrumental: string;
};

type ResultData = TrackInfo & {
  totalDurationFrames: number;
};

type AppStatus = 'idle' | 'processing' | 'success' | 'error';
type EDLSeveral = { fileName: string; sessionName: string };

// --- React Components ---

const Loader = () => (
  <div className="loader-container">
    <div className="loader"></div>
    <p>Processing EDL files and enriching data with Gemini...</p>
  </div>
);

const DropZone = ({ onFilesAdded }: { onFilesAdded: (files: File[]) => void }) => {
  const [dragging, setDragging] = useState(false);

  const handleDragEnter = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(true);
  };
  const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
  };
  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
  };
  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
    const files = [...e.dataTransfer.files];
    if (files && files.length > 0) {
      onFilesAdded(files);
    }
  };

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files ? [...e.target.files] : [];
     if (files && files.length > 0) {
      onFilesAdded(files);
    }
  };

  return (
    <div
      className={`dropzone ${dragging ? 'dragging' : ''}`}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onClick={() => document.getElementById('file-input')?.click()}
    >
      <p>Drag & Drop EDL files here</p>
      <p>or <span className="file-input-label">browse files</span></p>
      <input
        id="file-input"
        type="file"
        multiple
        accept=".txt,.r,text/plain"
        style={{ display: 'none' }}
        onChange={handleFileChange}
      />
    </div>
  );
};

const EDLSummary = ({ summaries }: { summaries: EDLSeveral[] }) => (
    <div className="summary-section">
        <h3>Processed EDL Summary</h3>
        {summaries.map((summary, index) => (
            <div key={index} className="summary-item">
                <p><span>Session:</span> {summary.sessionName}</p>
                <p><span>File:</span> {summary.fileName}</p>
            </div>
        ))}
    </div>
);

const ResultsTable = ({ data, onReset }: { data: ResultData[]; onReset: () => void }) => {

  const exportToCsv = () => {
    const headers = ['Music Title', 'Music Source', 'Composer(s)', 'Performer(s)', 'Publisher(s)', 'Catalogue Code', 'Track No.', 'Duration', 'Music Usage', 'Vocal/Instrumental', 'Source Filename'];
    const rows = data.map(track => [
      track.title,
      track.musicSource,
      track.composers?.join(', ') ?? '',
      track.performers?.join(', ') ?? '',
      track.publisher ?? '',
      track.catalogueCode ?? '',
      track.trackNo ?? '',
      framesToHMS(track.totalDurationFrames),
      'Background', // Music Usage
      track.vocalOrInstrumental,
      track.originalName,
    ].map(cell => `"${String(cell ?? '').replace(/"/g, '""')}"`));

    let csvContent = "data:text/csv;charset=utf-8,"
      + headers.join(',') + '\n'
      + rows.map(e => e.join(',')).join('\n');

    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", "music_cue_sheet.csv");
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };
  
  const getRowClass = (musicSource: string) => {
    switch (musicSource) {
      case 'Commercial Recording':
        return 'commercial-track';
      case 'Commissioned':
        return 'commissioned-track';
      default:
        return '';
    }
  };

  return (
    <>
      <div className="results-header">
         <h2>Processed Cue Sheet</h2>
        <button className="button" onClick={exportToCsv}>Export as CSV</button>
      </div>
      <div className="table-container">
        <table>
          <thead>
            <tr>
              <th className="wide-column">Music Title</th>
              <th>Music Source</th>
              <th className="wide-column">Composer(s)</th>
              <th className="wide-column">Performer(s)</th>
              <th className="wide-column">Publisher(s)</th>
              <th>Catalogue Code</th>
              <th>Track No.</th>
              <th className="no-wrap">Duration</th>
              <th className="no-wrap">Music Usage</th>
              <th className="no-wrap">Vocal/Instrumental</th>
              <th className="wide-column">Source Filename</th>
            </tr>
          </thead>
          <tbody>
            {data.map((item, index) => (
              <tr key={index} className={getRowClass(item.musicSource)}>
                <td className="wide-column">{item.title}</td>
                <td>{item.musicSource}</td>
                <td className="wide-column">
                  {item.composers?.map((composer, i) => (
                    <div key={i}>{composer}</div>
                  ))}
                </td>
                <td className="wide-column">
                  {item.performers?.map((performer, i) => (
                    <div key={i}>{performer}</div>
                  ))}
                </td>
                <td className="wide-column">{item.publisher}</td>
                <td>{item.catalogueCode}</td>
                <td>{item.trackNo}</td>
                <td className="no-wrap">{framesToHMS(item.totalDurationFrames)}</td>
                <td className="no-wrap">Background</td>
                <td className="no-wrap">{item.vocalOrInstrumental}</td>
                <td className="wide-column">{item.originalName}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
       <button className="button" onClick={onReset} style={{marginTop: '2rem'}}>Process New Files</button>
    </>
  );
};


function App() {
  const [status, setStatus] = useState<AppStatus>('idle');
  const [results, setResults] = useState<ResultData[]>([]);
  const [summaries, setSummaries] = useState<EDLSeveral[]>([]);
  const [errorMessage, setErrorMessage] = useState('');
  const [mkrCommissionedDatabase, setMkrCommissionedDatabase] = useState('');

  useEffect(() => {
    fetch('/Commissioned_Databases/MKR Composed_Database.txt')
        .then(response => {
            if (!response.ok) {
                throw new Error('Network response was not ok');
            }
            return response.text();
        })
        .then(text => setMkrCommissionedDatabase(text))
        .catch(error => {
            console.error('Error fetching MKR database:', error)
            setErrorMessage('Could not load the commissioned music database. Please check the file path and network connection.');
            setStatus('error');
        });
  }, []);

  const processFiles = useCallback(async (files: File[]) => {
    setStatus('processing');
    setResults([]);
    setSummaries([]);
    setErrorMessage('');

    try {
      if (!mkrCommissionedDatabase) {
        throw new Error("The Commissioned Music Database has not loaded yet. Please wait a moment and try again.");
      }
      const trackClips = new Map<string, Clip[]>();
      const baseNameToOriginalName = new Map<string, string>();
      const clipRegex = /^\d+\s+\d+\s+(.+?)\s+([\d:]{11})\s+([\d:]{11})\s+([\d:]{11})\s+(Muted|Unmuted)$/;
      const newSummaries: EDLSeveral[] = [];

      for (const file of files) {
        const text = await file.text();
        const lines = text.split('\n');
        
        const sessionLine = lines.find(line => line.startsWith('SESSION NAME:'));
        const sessionName = sessionLine ? sessionLine.replace('SESSION NAME:', '').trim() : 'Unknown Session';
        newSummaries.push({ fileName: file.name, sessionName: sessionName });

        for (const line of lines) {
          const match = line.trim().match(clipRegex);
          if (match) {
            const [, clipName, startTime, endTime, , state] = match;
            if (state === 'Unmuted') {
              const baseName = getBaseTrackName(clipName);
              
              if (!baseNameToOriginalName.has(baseName)) {
                baseNameToOriginalName.set(baseName, cleanTrackName(clipName));
              }

              const clips = trackClips.get(baseName) || [];
              clips.push({
                startTimeFrames: timecodeToFrames(startTime),
                endTimeFrames: timecodeToFrames(endTime),
              });
              trackClips.set(baseName, clips);
            }
          }
        }
      }
      setSummaries(newSummaries);
      
      const trackDurations = new Map<string, number>();
      for (const [baseName, clips] of trackClips.entries()) {
          if (clips.length === 0) continue;

          clips.sort((a, b) => a.startTimeFrames - b.startTimeFrames);

          let totalDurationFrames = 0;
          let currentStart = clips[0].startTimeFrames;
          let currentEnd = clips[0].endTimeFrames;

          for (let i = 1; i < clips.length; i++) {
              const clip = clips[i];
              if (clip.startTimeFrames <= currentEnd + 1) { 
                  currentEnd = Math.max(currentEnd, clip.endTimeFrames);
              } else {
                  totalDurationFrames += (currentEnd - currentStart);
                  currentStart = clip.startTimeFrames;
                  currentEnd = clip.endTimeFrames;
              }
          }
          totalDurationFrames += (currentEnd - currentStart);
          const originalName = baseNameToOriginalName.get(baseName)!;
          trackDurations.set(originalName, totalDurationFrames);
      }


      if (trackDurations.size === 0) {
        throw new Error("No valid unmuted music clips found in the provided files.");
      }

      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const trackNames = Array.from(trackDurations.keys());

      // --- STEP 1: Initial enrichment from filenames ---
      const initialEnrichmentSchema = {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            originalName: { type: Type.STRING, description: 'The original, representative track filename from the input list.' },
            title: { type: Type.STRING, description: "The final, reportable title of the music track." },
            composers: { type: Type.ARRAY, items: { type: Type.STRING } },
            performers: { type: Type.ARRAY, items: { type: Type.STRING } },
            publisher: { type: Type.STRING, description: "The PARENT publisher (e.g., Beatbox, Extreme Music, Universal Production Music)." },
            catalogueCode: { type: Type.STRING, description: "The combined library prefix and catalogue number (e.g., 'CRB1234', 'KPM567')." },
            musicSource: { type: Type.STRING, enum: ["Production Music (library)", "Commercial Recording", "Commissioned"] },
            trackNo: { type: Type.STRING },
            vocalOrInstrumental: { type: Type.STRING, description: "The version (e.g., Instrumental, Vocal). Default to 'Vocal' if not specified." },
          },
          required: ["originalName", "title", "musicSource", "vocalOrInstrumental"],
        },
      };

      const initialPrompt = `You are a musicologist and expert in music licensing for the APRA AMCOS framework in Australia. Your task is to analyze a list of music track filenames from an EDL and extract detailed information based ONLY on the filename and the provided databases.

**CRITICAL RULE: MKR Commissioned Music Database**
The following is your PRIMARY SOURCE OF TRUTH for any filename starting with "MKR". You MUST use this data to populate the fields.
- 'FILENAME' maps to 'originalName'.
- 'TRACK TITLE FOR REPORTING' maps to 'title'.
- 'COMPOSER/S' maps to 'composers'.
- 'PUBLISHER' maps to 'publisher'.
- Set 'musicSource' to 'Commissioned'.
- The catalogueCode should be the SERIES value (e.g., 'SERIES 11').
---
${mkrCommissionedDatabase}
---

**APRA AMCOS Production Music Libraries Reference**
This is a non-exhaustive list of production music libraries and publishers active in Australia. Use this list to help identify if a track is from a production library.
- 101 Music
- Adrenalin Sounds Pty Ltd / Adrenalin Production Music Libraries P/L
- Amphibious Zoo Music
- Audio Network
- Beatbox Music Pty Ltd
- Beats Fresh
- Blonde Beats
- BMG Production Music
- Extreme Music
- Fable Music Pty Ltd
- Fold Music Australia
- Motion Focus Music
- Mushroom Production Music
- Off The Shelf Music
- Primerchord Music
- Red Music Publishing Pty Ltd
- Standard Music Library
- Universal Production Music (UPM)
- West One Music Group Pty Ltd
- Woodcut Productions Ltd

**Instructions for NON-MKR Tracks:**

1.  **Identify Music Source**: Categorize as 'Production Music (library)' or 'Commercial Recording' (e.g., Katy Perry, The Weeknd). Use the reference list above to identify production music.
2.  **Determine Publisher**: This is vital. Use the official APRA AMCOS supplier list as your reference. Identify the PARENT publisher from the catalogue prefix.
    *   **Beatbox Music**: \`CRB\`, \`DBX\`, \`NLM\`, \`BAM\`, \`HML\`, \`ALSO\`, \`RSM\`, \`BKM\`, \`THH\`, \`MNM\`, \`ALL\`, \`LVM\`, \`MSU\`, \`BXMT\`, \`PMOL\`, \`FFM\`, \`AUMT\`.
    *   **Extreme Music**: \`ATN\`, \`KPM\`, \`XCD\`, \`TRC\`, \`FA162\`, \`MX456\`, \`XRC\`, \`KTC\`, \`TRL\`.
    *   **Universal Production Music (UPM)**: \`UPM_\` prefix.
    *   **BMG Production Music**: \`BMGPM_\` prefix.
    *   **West One Music**: \`WESTONE_\` prefix.
    *   **The DA's Office**: They handle many bespoke libraries. Use your knowledge for this.
    *   If a publisher can't be determined, leave the field blank.
3.  **Extract Details from Filename**:
    *   **Title**: The clean title of the track. Remove file extensions, catalogue prefixes, composer names/initials, and versioning info (e.g., '_INST', '_FULL', 'V2'). Replace underscores with spaces.
    *   **Composer(s)/Performer(s)**: This is a critical step. For Production Music, you are looking for **Composers**. For Commercial Recordings, you are looking for **Performers/Artists**.
        *   Analyze the filename for patterns that indicate composer names or initials, which are often at the end.
        *   Common patterns include: \`TITLE_ComposerName\`, \`TITLE_Composer1_Composer2\`, \`TITLE - C_FirstnameLastname\`, \`TITLE_CI\` (where CI are composer initials).
        *   Names can also be in parentheses, e.g., \`Title (Composer Name)\`.
        *   If you identify composers, list them in the 'composers' field. If it's a commercial artist, list them in the 'performers' field. Do not populate both for the same track. If no composer/performer is in the filename, leave the field empty.
    *   **Catalogue Code**: Combine the library prefix and the record number into one string (e.g., 'CRB' and '1234' becomes 'CRB1234').
    *   **Track No.**: Extract if present in the filename.

**Filenames to process:**
${trackNames.join('\n')}`;

      const initialResponse = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: initialPrompt,
        config: {
          responseMimeType: 'application/json',
          responseSchema: initialEnrichmentSchema,
        }
      });
      
      const enrichedData: TrackInfo[] = JSON.parse(initialResponse.text);

      // --- Post-processing tweak for Commissioned tracks ---
      enrichedData.forEach(track => {
        if (track.musicSource === 'Commissioned') {
          // Tweak the title to be parsed from the filename for better detail
          track.title = parseMkrTitle(track.originalName);

          // Tweak composer name format from "LastName FirstName" to "FirstName LastName" for consistency
          if (track.composers) {
            track.composers = track.composers.map(formatMkrComposerName);
          }
        }
      });
      
      // --- STEP 2: Web search for missing composers on production tracks ---
      const tracksToSearch = enrichedData.filter(
        track => track.musicSource === 'Production Music (library)' && (!track.composers || track.composers.length === 0)
      );

      if (tracksToSearch.length > 0) {
        const searchPromises = tracksToSearch.map(track => {
          const systemInstruction = `You are a highly efficient music data retrieval agent. Your sole purpose is to find composer names for a given music track and return them in a specific format. You MUST NOT output any conversational text, explanations, reasoning, or apologies. Your entire response will be parsed by a machine, so it must be exact. If you cannot find the composer, return an empty string.`;

          const searchPrompt = `Using the Google Search tool, find the composer(s) for the following track. Prioritize searching \`portal.apraamcos.com.au\` first, then other official publisher websites.

**Track Information:**
- Title: "${track.title}"
- Publisher / Library: "${track.publisher || track.catalogueCode || ''}"

**MANDATORY OUTPUT FORMAT:**
- Return ONLY a comma-separated list of composer names.
- Example: \`John Williams, Hans Zimmer\`
- DO NOT add any other text.`;
          
          return ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: searchPrompt,
            config: {
              systemInstruction: systemInstruction,
              tools: [{ googleSearch: {} }],
            },
          }).then(searchResponse => {
            let composerText = searchResponse.text.trim();
            
            // Post-processing to handle cases where the model still includes its reasoning
            if (composerText.length > 150 && composerText.includes('\n')) {
              const lines = composerText.split('\n').filter(line => line.trim() !== '');
              if (lines.length > 0) {
                  composerText = lines[lines.length - 1].trim();
              }
            }

            // Clean up any lingering conversational prefixes or bad characters.
            composerText = composerText.replace(/^.*?: ?/, '').trim();

            if (composerText) {
              // Update the original track object
              track.composers = composerText.split(',').map(name => name.trim()).filter(Boolean);
            }
          }).catch(err => {
            console.warn(`Could not fetch composer for "${track.title}":`, err);
            // Don't modify track on error, just log it
          });
        });
        await Promise.all(searchPromises);
      }

      // --- STEP 3: Web search for missing writers on commercial tracks ---
      const commercialTracksToSearch = enrichedData.filter(
        track =>
          track.musicSource === 'Commercial Recording' &&
          (!track.composers || track.composers.length === 0)
      );

      if (commercialTracksToSearch.length > 0) {
        const commercialSearchPromises = commercialTracksToSearch.map(track => {
          const systemInstruction = `You are a highly efficient music data retrieval agent. Your sole purpose is to find the songwriters/composers for a given commercial music track and return them in a specific format. You MUST NOT output any conversational text, explanations, reasoning, or apologies. Your entire response will be parsed by a machine, so it must be exact. If you cannot find the writers, return an empty string.`;
          
          const performerName = track.performers && track.performers.length > 0 ? track.performers[0] : '';
          const searchPrompt = `Using the Google Search tool, find the official songwriter(s)/composer(s) for the following commercial music track. Prioritize official sources like Wikipedia, ASCAP, BMI, APRA AMCOS, or official artist websites.

**Track Information:**
- Title: "${track.title}"
- Artist/Performer: "${performerName}"

**MANDATORY OUTPUT FORMAT:**
- Return ONLY a comma-separated list of full composer/songwriter names.
- Example: \`Max Martin, Shellback, Taylor Swift\`
- DO NOT add any other text.`;
          
          return ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: searchPrompt,
            config: {
              systemInstruction: systemInstruction,
              tools: [{ googleSearch: {} }],
            },
          }).then(searchResponse => {
            let composerText = searchResponse.text.trim();
            
            if (composerText.length > 150 && composerText.includes('\n')) {
              const lines = composerText.split('\n').filter(line => line.trim() !== '');
              if (lines.length > 0) {
                  composerText = lines[lines.length - 1].trim();
              }
            }
            composerText = composerText.replace(/^.*?: ?/, '').trim();

            if (composerText) {
              track.composers = composerText.split(',').map(name => name.trim()).filter(Boolean);
            }
          }).catch(err => {
            console.warn(`Could not fetch composers for commercial track "${track.title}":`, err);
          });
        });
        await Promise.all(commercialSearchPromises);
      }

      // --- Finalize Results ---
      const finalResults = enrichedData.map(info => ({
        ...info,
        totalDurationFrames: trackDurations.get(info.originalName) || 0,
      }));
      
      finalResults.sort((a,b) => a.title.localeCompare(b.title));

      setResults(finalResults);
      setStatus('success');

    } catch (e) {
      console.error(e);
      setErrorMessage(e.message || 'An unknown error occurred during processing.');
      setStatus('error');
    }
  }, [mkrCommissionedDatabase]);

  const handleReset = () => {
    setStatus('idle');
    setResults([]);
    setSummaries([]);
  }

  const renderContent = () => {
    switch(status) {
      case 'processing':
        return <Loader />;
      case 'success':
        return (
            <>
                {summaries.length > 0 && <EDLSummary summaries={summaries} />}
                <ResultsTable data={results} onReset={handleReset} />
            </>
        );
      case 'error':
        return (
          <>
            <p className="error-message">{errorMessage}</p>
            <button className="button" onClick={handleReset} style={{marginTop: '1rem'}}>Try Again</button>
          </>
        );
      case 'idle':
      default:
        return <DropZone onFilesAdded={processFiles} />;
    }
  };

  return (
    <div className="container">
      <div className="header">
        <h1 className="app-title">The Cue-rator</h1>
        <p>Upload your EDL files to automatically parse, aggregate, and enrich your music cue data.</p>
      </div>
      {renderContent()}
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root')!);
root.render(<App />);