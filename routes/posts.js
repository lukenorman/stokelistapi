const Router = require('express-promise-router')
const { Op } = require('sequelize')
const validator = require('validator')
const passport = require('passport')
const Recaptcha = require('express-recaptcha').RecaptchaV3

const { sendPostValidationMessage } = require('../mail')
const Post = require('../models/post')
const User = require('../models/user')
const Media = require('../models/media')
const { trimPostDescriptions } = require('../util/posts')

const recaptcha = new Recaptcha(
    process.env.CAPTCHA_KEY,
    process.env.CAPTCHA_SECRET
)

// this has the same API as the normal express router except
// it allows you to use async functions as route handlers
const router = new Router()
// export our router to be mounted by the parent application
module.exports = router

const postAttributes = [
    'id',
    'title',
    'price',
    'location',
    'description',
    'photoFileSize',
    'exactLocation',
    'isGarageSale',
    'startTime',
    'endTime',
    'created_at',
]

const POST_LIMIT = 50

const standardGetOrder = [
    ['created_at', 'DESC'],
    ['media', 'created_at', 'ASC'],
]

const whereClause = {
    emailVerified: true,
    moderated: false,
}

const includeMedia = [
    {
        model: Media,
        as: 'media',
    },
]

//Get 50 latest posts, with optional offset
router.get('/', async (req, res) => {
    const offset = !isNaN(req.query.offset) ? parseInt(req.query.offset) : 0
    console.log(`Loading latest posts with offset ${offset}`)
    const posts = await Post.findAll({
        attributes: postAttributes,
        where: { ...whereClause },
        order: standardGetOrder,
        limit: POST_LIMIT,
        offset: offset,
        include: includeMedia,
    })
    return res.json(trimPostDescriptions(posts))
})

//Returns all future garage sales
router.get('/garage', async (req, res) => {
    console.log(`Loading garage sales`)
    const posts = await Post.findAll({
        attributes: postAttributes,
        where: {
            ...whereClause,
            isGarageSale: true,
            endTime: { [Op.gt]: new Date().toISOString() },
            exactLocation: {
                [Op.ne]: null,
            },
        },
        include: includeMedia,
        order: [
            ['startTime', 'ASC'],
            ['media', 'created_at', 'ASC'],
        ],
    })
    return res.json(trimPostDescriptions(posts))
})

//Get 50 posts that correspond to the search term, with optional offset
router.get('/search', async (req, res) => {
    const query = '%' + req.query.term + '%'
    const offset = !isNaN(req.query.offset) ? parseInt(req.query.offset) : 0
    console.log(
        `Running search for query term ${req.query.term} with offset ${offset}`
    )
    const posts = await Post.findAll({
        attributes: postAttributes,
        where: {
            ...whereClause,
            [Op.or]: {
                description: {
                    [Op.iLike]: query,
                },
                title: {
                    [Op.iLike]: query,
                },
            },
        },
        order: standardGetOrder,
        limit: POST_LIMIT,
        offset: offset,
        include: includeMedia,
    })
    return res.json(trimPostDescriptions(posts))
})

//Get all sticky posts
router.get('/sticky', async (req, res) => {
    console.log('Loading sticky posts')
    const posts = await Post.findAll({
        attributes: postAttributes,
        where: {
            ...whereClause,
            sticky: true,
        },
        order: standardGetOrder,
        include: includeMedia,
    })
    return res.json(trimPostDescriptions(posts))
})

//Get all posts made by an authenticated user
router.get(
    '/mine',
    passport.authenticate('jwt', { session: false }),
    async (req, res) => {
        const userEmail = req.user.email
        console.log(`Loading posts for user: ${userEmail}`)
        const posts = await Post.findAll({
            attributes: postAttributes,
            where: {
                ...whereClause,
                email: userEmail,
            },
            order: standardGetOrder,
            include: includeMedia,
        })
        return res.json(trimPostDescriptions(posts))
    }
)

//Get a single post, by public ID
router.get('/:id', async (req, res) => {
    const postID = !isNaN(req.params.id) ? parseInt(req.params.id) : null
    console.log(`Loading posts for id ${postID}`)
    const post = await Post.findOne({
        attributes: postAttributes,
        where: {
            ...whereClause,
            id: postID,
        },
        include: includeMedia,
        order: [['media', 'created_at', 'ASC']],
    })
    return res.json(post)
})

//Validate a single post, by private guid
router.post('/v/:uuid', async (req, res) => {
    const postUUID = validator.isUUID(req.params.uuid) ? req.params.uuid : null
    console.log(`Validating post with uuid ${postUUID}`)
    let post = await Post.findOne({
        where: {
            guid: postUUID,
        },
        include: includeMedia,
    })
    if (post && post.emailVerified === false) {
        post.emailVerified = true
        //Handle any posts created in the old system, but not yet verified by
        //doing a findOrCreate here
        let [user] = await User.findOrCreate({
            where: {
                email: post.email,
            },
        })
        const postCount = await Post.count({ where: { email: post.email } })
        const moderatedPosts = await Post.count({
            where: { email: post.email, moderated: true },
        })
        if (postCount === 1 || moderatedPosts > 0) {
            //If this is the first post a user is validating
            //or if any of their other posts are moderated
            //then moderate this post
            post.moderated = true
        } else {
            await post.publiciseMedia()
        }
        await post.save()
        const returnObject = { post, token: user.generateToken() }
        console.log(`Validated post with uuid ${postUUID}`)
        return res.status(200).send(returnObject)
    } else {
        console.log(`Unable to validate post with uuid ${postUUID}`)
        return res.sendStatus(404)
    }
})

//Delete a single post, by id, with authentication
router.delete(
    '/:id',
    passport.authenticate('jwt', { session: false }),
    async (req, res) => {
        console.log(`Attempting to delete post with id ${req.params.id}`)
        const postID = !isNaN(req.params.id) ? parseInt(req.params.id) : null
        //If logged in and post ID is a valid number
        if (postID !== null) {
            let post = await Post.findByPk(postID, { include: includeMedia })
            if (post.hasPermissions(req.user)) {
                await post.destroy()
                await post.privatizeMedia()
                console.log(`Deleted post with id ${postID}`)
                return res.sendStatus(204)
            }
        }
        console.log(`Error deleting post with id ${postID}`)
        return res.sendStatus(403)
    }
)

//Undelete a single post, by id, with authentication
//Not entirely RESTful, using PATCH here
router.patch(
    '/:id',
    passport.authenticate('jwt', { session: false }),
    async (req, res) => {
        console.log(`Attempting to delete post with id ${req.params.id}`)
        const postID = !isNaN(req.params.id) ? parseInt(req.params.id) : null
        //If logged in and post ID is a valid number
        const userEmail = req.user.email
        if (postID !== null) {
            let post = await Post.findByPk(postID, {
                paranoid: false,
                include: includeMedia,
            })
            if (post && post.email === userEmail) {
                await post.restore()
                if (post.moderated !== true) {
                    await post.publiciseMedia()
                }
                console.log(`Undeleted post with id ${postID}`)
                return res.sendStatus(204)
            }
        }
        console.log(`Error undeleting post with id ${postID}`)
        return res.sendStatus(403)
    }
)

//Update a single post, by id, with authentication
router.put(
    '/:id',
    passport.authenticate('jwt', { session: false }),
    async (req, res) => {
        console.log(`Attempting to update post with id ${req.params.id}`)
        const postID = !isNaN(req.params.id) ? parseInt(req.params.id) : null
        if (postID !== null) {
            let post = await Post.findByPk(postID, {
                include: includeMedia,
            })
            const userEmail = req.user.email
            if (post && post.email === userEmail) {
                post.title = req.body.title || null
                post.description = req.body.description || null
                post.price = req.body.price || null
                post.location = req.body.location || null
                post.exactLocation = req.body.exactLocation || null
                post.isGarageSale = req.body.isGarageSale || false
                post.startTime = req.body.startTime || null
                post.endTime = req.body.endTime || null
                try {
                    await post.validate()
                } catch (e) {
                    console.log('New post validation failed')
                    return res.sendStatus(422)
                }
                await post.save()
                //The media submitted by the user
                const mediaArray = req.body.media || []
                for (let existingMedia of post.media) {
                    //Find if we already have a media with this ID
                    const updatedMedia = mediaArray.find(
                        (media) => media.id === existingMedia.id
                    )
                    if (updatedMedia) {
                        //If we do, just update it
                        existingMedia.name = updatedMedia.name || ''
                        await existingMedia.save()
                    } else {
                        //Otherwise, explicit media delete
                        await existingMedia.destroy()
                    }
                }
                //Any media with a GUID must be new
                const newMedia = mediaArray.filter((x) => x.guid !== null)
                for (let media of newMedia) {
                    await Media.assign(media, post.id)
                }
                console.log(`Updated post with id ${postID}`)
                return res.json(post)
            }
        }
        console.log(`Error updating post with id ${postID}`)
        return res.sendStatus(403)
    }
)

//Create a new post
router.post('/', recaptcha.middleware.verify, async (req, res) => {
    console.log(`Building new post`)
    const recaptcha = req.recaptcha
    const passingScore = parseFloat(process.env.CAPTCHA_SCORE) || 0.5
    //Check that the captcha passed in meets our requirements
    if (
        !recaptcha.error &&
        recaptcha.data.action === 'post' &&
        recaptcha.data.score > passingScore
    ) {
        console.log('Valid captcha token')
        const post = await Post.build({
            title: req.body.title || null,
            description: req.body.description || null,
            price: req.body.price || null,
            email: req.body.email || null,
            location: req.body.location || null,
            exactLocation: req.body.exactLocation || null,
            isGarageSale: req.body.isGarageSale || false,
            startTime: req.body.startTime || null,
            endTime: req.body.endTime || null,
            remoteIp: req.ip,
        })
        try {
            await post.validate()
            const isBanned = await User.isBanned(post.email)
            if (isBanned) {
                console.log(
                    `Skipping post creation for banned user: ${post.email}`
                )
            } else {
                await post.save()
                const mediaArray = req.body.media
                if (Array.isArray(mediaArray) && mediaArray.length > 0) {
                    for (let m of mediaArray) {
                        await Media.assign(m, post.id)
                    }
                }
                sendPostValidationMessage(post)
                console.log(
                    `New post saved and validation email sent to ${post.email}`
                )
                return res.sendStatus(204)
            }
        } catch (e) {
            console.log('New post validation failed')
        }
    }
    //Throw 'post validation failed response if captcha auth fails
    return res.sendStatus(422)
})
