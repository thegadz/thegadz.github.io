(() => {
    const GOOGLE_SHEET_ID = '1a5j9jRPAa1K5qBbQuPzrmx7C9qBGew9vpZuJhC2E-C8';
    const GOOGLE_SHEET_NAME = 'Sheet1';

    const GOOGLE_SHEET_URL = `https://docs.google.com/spreadsheets/d/${GOOGLE_SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(GOOGLE_SHEET_NAME)}`;
    const USE_GOOGLE_SHEET = GOOGLE_SHEET_ID && GOOGLE_SHEET_ID.trim() !== '';

    function decodeDataUrl(dataUrl) {
        if (dataUrl.startsWith('data:')) {
            const base64Match = dataUrl.match(/data:.*?;base64,(.+)/);
            if (base64Match && base64Match[1]) {
                try {
                    const base64String = base64Match[1];
                    const decodedText = atob(base64String);
                    console.log('Decoded base64 data URL, got', decodedText.length, 'characters');
                    return decodedText;
                } catch (decodeError) {
                    console.warn('Failed to decode base64 data URL:', decodeError);
                    throw new Error('Invalid base64 data URL format');
                }
            }
        }
        return dataUrl;
    }

    async function fetchWithCorsProxy(url) {
        const corsProxies = [
            [`https://api.allorigins.win/get?url=${encodeURIComponent(url)}`, true],
            [`https://corsproxy.io/?${encodeURIComponent(url)}`, false],
            [`https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`, false],
        ];

        for (const [proxyUrl, needsJsonParse] of corsProxies) {
            try {
                console.log('Trying CORS proxy:', proxyUrl.substring(0, 50) + '...');
                const response = await fetch(proxyUrl, {
                    method: 'GET',
                    headers: {
                        'Accept': 'text/csv, text/plain, */*'
                    }
                });

                if (!response.ok) {
                    throw new Error(`Proxy HTTP ${response.status}: ${response.statusText}`);
                }

                let data = await response.text();

                if (data.startsWith('data:')) {
                    console.log('Proxy returned data URL, decoding base64...');
                    data = decodeDataUrl(data);
                } else if (needsJsonParse || proxyUrl.includes('allorigins.win')) {
                    try {
                        const json = JSON.parse(data);
                        data = json.contents || json.content || json.data || data;
                        if (typeof data !== 'string') {
                            data = JSON.stringify(data);
                        }

                        if (data && typeof data === 'string' && data.startsWith('data:')) {
                            console.log('JSON content is a data URL, decoding...');
                            data = decodeDataUrl(data);
                        }
                    } catch (parseError) {
                        console.log('Proxy returned plain text, not JSON');
                    }
                }

                if (!data || data.trim().length === 0) {
                    throw new Error('Proxy returned empty response');
                }

                console.log('CORS proxy succeeded, received', data.length, 'bytes');
                return data;

            } catch (proxyError) {
                console.warn('CORS proxy failed:', proxyError.message);
                continue;
            }
        }

        throw new Error('All CORS proxies failed - none of the proxy services responded successfully');
    }

    function parseCSVLine(line) {
        const result = [];
        let current = '';
        let inQuotes = false;

        for (let i = 0; i < line.length; i++) {
            const char = line[i];

            if (char === '"') {
                inQuotes = !inQuotes;
            } else if (char === ',' && !inQuotes) {
                result.push(current);
                current = '';
            } else {
                current += char;
            }
        }

        result.push(current);
        return result;
    }

    function parseCSV(context, csvText) {
        const lines = csvText.split('\n').filter(line => line.trim() !== '');
        const headers = lines[0].split(',');

        context.games = lines.slice(1).map((line, index) => {
            const values = parseCSVLine(line);
            const game = {};
            headers.forEach((header, i) => {
                game[header.trim()] = values[i] ? values[i].trim() : '';
            });

            game.price = parseFloat(game.price) || 0;
            game.rating = parseFloat(game.rating) || 0;
            game.id = parseInt(game.id) || index + 1;
            return game;
        });

        context.categories = [...new Set(context.games.map(game => game.category))].sort();
    }

    async function loadGames(context) {
        const cachedGames = getCache('gamesData');
        if (cachedGames) {
            context.games = cachedGames.games;
            context.lastFetchTime = cachedGames.lastFetchTime;
            context.filteredGames = [...context.games];
            context.updateStatistics();
            context.isLoading = false;
            console.log('Loaded from cache, last fetched at', new Date(context.lastFetchTime).toISOString());

            const timeDiff = new Date().getTime() - context.lastFetchTime;
            console.log('Time difference:', timeDiff, 'ms');
            if (timeDiff < 1000 * 60 * 5) {            
                console.log('Cache is less than 5 minutes old, skipping fetch...');
                return;
            }
        }

        context.isLoading = true;
        context.errorMessage = '';

        try {
            let csvText;

            if (USE_GOOGLE_SHEET) {
                let googleSheetError = null;

                const urlFormats = [
                    `https://docs.google.com/spreadsheets/d/${GOOGLE_SHEET_ID}/export?format=csv&gid=0`,
                    `https://docs.google.com/spreadsheets/d/${GOOGLE_SHEET_ID}/export?format=csv&sheet=${encodeURIComponent(GOOGLE_SHEET_NAME)}`,
                    GOOGLE_SHEET_URL,
                    `https://docs.google.com/spreadsheets/d/${GOOGLE_SHEET_ID}/gviz/tq?tqx=out:csv&gid=0`,
                ];

                console.log('Fetching Google Sheet via CORS proxy (Google Sheets blocks direct browser access)...');
                for (const url of urlFormats) {
                    try {
                        csvText = await fetchWithCorsProxy(url);

                        if (csvText.trim().startsWith('<') || csvText.includes('<!DOCTYPE')) {
                            console.warn('Received HTML instead of CSV, trying next URL format...');
                            continue;
                        }

                        if (csvText.trim().length === 0) {
                            console.warn('Sheet appears to be empty, trying next URL format...');
                            continue;
                        }

                        const firstLine = csvText.split('\n')[0];
                        if (!firstLine || firstLine.trim().length === 0) {
                            console.warn('Invalid CSV format, trying next URL format...');
                            continue;
                        }

                        console.log('Successfully loaded from Google Sheet (via proxy)');
                        break;

                    } catch (proxyError) {
                        console.warn(`Proxy fetch failed for URL format: ${url}`, proxyError);
                        googleSheetError = proxyError;
                        continue;
                    }
                }

                if (!csvText) {
                    console.warn('All Google Sheet URL formats failed via proxy, trying local fallback');
                    try {
                        const response = await fetch('games.csv');
                        if (!response.ok) {
                            throw new Error(`Failed to load local CSV: ${response.status}`);
                        }
                        csvText = await response.text();
                        console.log('Loaded from local games.csv fallback');
                    } catch (localError) {
                        throw new Error(`Google Sheet failed: ${googleSheetError?.message || 'All CORS proxies failed'}. Local CSV also failed: ${localError.message}`);
                    }
                }
            } else {
                const response = await fetch('games.csv');
                if (!response.ok) {
                    throw new Error(`Failed to load games.csv: ${response.status} ${response.statusText}`);
                }
                csvText = await response.text();
            }

            parseCSV(context, csvText);
            context.filteredGames = [...context.games];
            context.updateStatistics();
            context.isLoading = false;
            context.lastFetchTime = new Date().getTime();

            // Cache the games data
            setCache('gamesData', {
                games: context.games,
                lastFetchTime: context.lastFetchTime,
            });
        } catch (error) {
            console.error('Error loading games:', error);
            context.errorMessage = `Failed to load games data: ${error.message}. Please check: 1) Sheet is shared publicly, 2) Sheet name is correct, 3) Your internet connection.`;
            context.games = context.getFallbackGames();
            context.filteredGames = [...context.games];
            context.updateStatistics();
            context.isLoading = false;
        }
    }

    window.GoogleSheet = {
        config: {
            GOOGLE_SHEET_ID,
            GOOGLE_SHEET_NAME,
            GOOGLE_SHEET_URL,
            USE_GOOGLE_SHEET,
        },
        decodeDataUrl,
        fetchWithCorsProxy,
        loadGames,
    };
})();
