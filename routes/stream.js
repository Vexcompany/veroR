const router = require('express').Router();
const c      = require('../controllers/streamController');

router.get('/home',             c.home);
router.get('/search',           c.search);
router.get('/suggest',          c.suggest);
router.get('/status',           c.status);
router.get('/related/:videoId', c.related);
router.get('/audio/:videoId',   c.audio);
router.head('/audio/:videoId',  c.audio);
router.get('/stream',           c.resolve);
router.post('/stream',          c.resolve);

module.exports = router;
