// Historical analytics API routes.
// Provides time-series metrics, events, and summary statistics.

import { Router } from 'express';
import {
  queryMetrics,
  queryEvents,
  querySummary,
  generateDemoMetrics,
  generateDemoEvents,
  generateDemoSummary,
} from '../analytics.js';

export default function analyticsRoutes(ctx) {
  const router = Router();

  /**
   * GET /analytics/metrics?from=&to=&bucket=
   * Returns bucketed metrics for charting.
   */
  router.get('/analytics/metrics', async (req, res) => {
    try {
      const { from, to, bucket } = req.query;
      if (ctx.config.demoMode) {
        return res.json({ metrics: generateDemoMetrics({ from, to }) });
      }
      const metrics = await queryMetrics({ from, to, bucketInterval: bucket });
      res.json({ metrics });
    } catch (err) {
      res.status(500).json({ error: 'Failed to query metrics: ' + err.message });
    }
  });

  /**
   * GET /analytics/events?from=&to=&type=
   * Returns server events (start, stop, crash, backup, etc.).
   */
  router.get('/analytics/events', async (req, res) => {
    try {
      const { from, to, type } = req.query;
      if (ctx.config.demoMode) {
        return res.json({ events: generateDemoEvents({ from, to }) });
      }
      const events = await queryEvents({ from, to, eventType: type });
      res.json({ events });
    } catch (err) {
      res.status(500).json({ error: 'Failed to query events: ' + err.message });
    }
  });

  /**
   * GET /analytics/summary?from=&to=
   * Returns aggregate statistics for a time range.
   */
  router.get('/analytics/summary', async (req, res) => {
    try {
      const { from, to } = req.query;
      if (ctx.config.demoMode) {
        return res.json({ summary: generateDemoSummary() });
      }
      const summary = await querySummary({ from, to });
      res.json({ summary });
    } catch (err) {
      res.status(500).json({ error: 'Failed to query summary: ' + err.message });
    }
  });

  return router;
}
