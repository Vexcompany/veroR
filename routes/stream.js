const router = require('express').Router();
const c      = require('../controllers/streamController');

router.get('/search',           c.search);
router.get('/suggest',          c.suggest);
router.get('/status',           c.status);
router.get('/related/:videoId', c.related);
router.get('/audio/:videoId',   c.audio);
router.head('/audio/:videoId',  c.audio);
router.get('/',                 c.resolve);
router.post('/',                c.resolve);

module.exports = router;
