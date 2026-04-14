import { app } from 'electron';
import {
  fetchLinkedInJobs,
  fetchUSAJobs,
  fetchRemoteOKJobs,
  fetchWeWorkRemotelyJobs,
  fetchDiceListings,
  fetchStockXListings,
  fetchReverbListings
} from './electron/extractors/apiExtractors.js';

app.whenReady().then(async () => {
  console.log('Testing Api Extractors (Electron Context)...');
  const results = {};

  const safeCall = async (name, fn) => {
    try {
      const data = await fn();
      results[name] = { success: true, count: Array.isArray(data) ? data.length : 'unknown', sample: data[0] };
    } catch (e) {
      results[name] = { success: false, error: e.message };
    }
  };

  await safeCall('LinkedIn', () => fetchLinkedInJobs('software engineer'));
  await safeCall('RemoteOK', () => fetchRemoteOKJobs('react'));
  await safeCall('WeWorkRemotely', () => fetchWeWorkRemotelyJobs('frontend'));
  await safeCall('Dice', () => fetchDiceListings('software engineer'));
  await safeCall('StockX', () => fetchStockXListings('iphone 15 pro', false));
  await safeCall('Reverb', () => fetchReverbListings('fender stratocaster', true, 'excellent'));

  console.log(JSON.stringify(results, null, 2));

  app.quit();
});
