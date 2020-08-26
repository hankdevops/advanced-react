const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const { randomBytes } = require('crypto')
const { promisify } = require('util')
const { transport, makeANiceEmail } = require('../mail')
const hasPermission = require('../utils')
const stripe = require('../stripe')

const Mutations = {
    async createItem(parent, args, ctx, info) {
        // TODO check if they are logged in
        if(!ctx.request.userId) {
            throw new Error('You must be logged in to do that!')
        }
        const item = await ctx.db.mutation.createItem({
            data: {
                // This is how to create a relationship between the Item and the User
                user: {
                    connect: {
                        id: ctx.request.userId
                    }
                },
                ...args
            }
        }, info)

        return item
    },
    updateItem(parent, args, ctx, info) {
        // first take a copy of the updates
        const updates = { ...args }
        // remove ID from the updates
        delete updates.id
        // run the update method
        return ctx.db.mutation.updateItem({
            data: updates,
            where: {
                id: args.id
            }
        }, info)

    },
    async deleteItem(parent, args, ctx, info) {
        const where = {id: args.id}
        // 1. Find the item
        const item = await ctx.db.query.item({ where }, `{id title user { id }}`)
        // 2. Check if they own that item, or have the permissions
        const ownsItem = item.user.id === ctx.request.userId
        const hasPermissions = ctx.request.user.permissions.some(permission => ['ADMIN', 'ITEMDELETE'].includes(permission))
        if (!ownsItem && !hasPermissions) {
            throw new Error('You don\'t have permission to do that!')
        }
        // 3. Delete it
        return ctx.db.mutation.deleteItem({ where }, info)
    },
    async signup(parent, args, ctx, info) {
        args.email = args.email.toLowerCase()
        const password = await bcrypt.hash(args.password, 10)
        const user = await ctx.db.mutation.createUser({
            data: {
                ...args,
                password,
                permissions: {set: ['USER']}
            }
        }, info)
        const token = jwt.sign({ userId: user.id}, process.env.APP_SECRET)
        ctx.response.cookie('token', token, {
            httpOnly: true,
            maxAge: 1000 * 60 * 60 * 24 * 365
        })
        return user
    },
    async signin(parent, {email, password}, ctx, info) {
        // 1. Check if there is a user with that email
        const user = await ctx.db.query.user({ where: { email }})
        if (!user) {
            throw new Error(`No such user found for email ${email}`)
        }
        // 2. Check if their password is correct
        const valid = await bcrypt.compare(password, user.password)
        if (!valid) {
            throw new Error('Invalid Password!')
        }
        // 3. generate the JWT token
        const token = jwt.sign({ userId: user.id}, process.env.APP_SECRET)
        // 4. Set the cookie with the token
        ctx.response.cookie('token', token, {
            httpOnly: true,
            maxAge: 1000 * 60 * 60 * 24 * 365
        })
        // 5. Return the user
        return user
    },
    signout(parent, args, ctx, info) {
        ctx.response.clearCookie('token')
        return {message: 'Goodbye!'}
    },
    async requestReset(parent, args, ctx, info) {
        // 1. Check if this is a real user
        const user = await ctx.db.query.user({where: {email: args.email}})
        if (!user) {
            throw new Error(`No such user found for email ${args.email}`)
        }
        // 2. Set a reset token and expiry on that user
        // const randomBytesPromisified = promifify(randomBytes)
        const resetToken = (await promisify(randomBytes)(20)).toString('hex')
        const resetTokenExpiry = Date.now() + 3600000
        const res = await ctx.db.mutation.updateUser({
            where: {email: args.email},
            data: {resetToken, resetTokenExpiry}
        })
        // 3. Email them that reset token
        const mailRes = await transport.sendMail({
            from: 'zachariasn@naver.com',
            to: user.email,
            subject: 'Your Password Reset Token',
            html: makeANiceEmail(`Your Password Reset Token is here! 
            \n\n 
            <a href="${process.env.FRONTEND_URL}/reset?resetToken=${resetToken}">Click Here to Reset</a>`)
        })

        return { message: 'Thanks!'}
    },
    async resetPassword(parent, args, ctx, info) {
        // 1. Check if the passwords match
        if (args.password !== args.confirmPassword) {
            throw new Error('Your passwords DO NOT match!')
        }
        // 2. Check if the token is legit
        // 3. Check if it expired
        const [user] = await ctx.db.query.users({
            where: {
                resetToken: args.resetToken,
                resetTokenExpiry_gte: Date.now() - 3600000
            }
        })
        if (!user) {
            throw new Error('This token is either invalid or expired!')
        }
        // 4. Hash their new password
        const password = await bcrypt.hash(args.password, 10)
        // 5. Save the new password and remove the old one
        const updatedUser = ctx.db.mutation.updateUser({
            where: { email: user.email },
            data: {
                password,
                resetToken: null,
                resetTokenExpiry: null
            }
        })
        // 6. Generate the JWT token
        const token = jwt.sign({userId: updatedUser.id}, process.env.APP_SECRET)
        // 7. Set the JWT cookie
        ctx.response.cookie('token', token, {
            httpOnly: true,
            maxAge: 1000 * 60 * 60 * 24 * 365
        })
        // 8. return the new user
        return updatedUser
    },
    async updatePermissions(parent, args, ctx, info) {
        // 1. Check if they are logged in
        if (!ctx.request.userId) {
            throw new Error('You must be logged in!')
        }
        // 2. Query the current user
        const currentUser = await ctx.db.query.user({
            where: {
                id: ctx.request.userId
            }
        }, info)
        // 3. Check if they have permissions
        hasPermission(currentUser, ['ADMIN', 'PERMISSIONUPDATE'])
        // 4. Update the permissions
        return ctx.db.mutation.updateUser({
            data: { permissions: {
                set: args.permissions
            }},
            where: {id: userId}
        }, info)
    },
    async addToCart(parent, args, ctx, info) {
        // 1. Make sure that they are signed in
        const userId = ctx.request.userId
        if (!userId) {
            throw new Error('You must be signed in to add items to your cart!')
        }
        // 2. Query the user's current cart
        const [ existingCartItem ] = await ctx.db.query.cartItems({
            where: {
                user: {id: userId},
                item: {id: args.id}
            }
        })
        // 3. Check if that item is alkready in the cart and increment if it is
        if (existingCartItem) {
            console.log('This item is already in their cart')
            return ctx.db.mutation.updateCartItem({
                where: { id: existingCartItem.id },
                data: { quantity: existingCartItem.quantity + 1 }
            }, info)
        }
        // 4. If it's not, create a fresh CartItem for that user
        return ctx.db.mutation.createCartItem({
            data: {
                user: {
                    connect: {id: userId}
                },
                item: {
                    connect: {id: args.id}
                }
            }
        }, info)
    },
    async removeFromCart(parent, args, ctx, info) {
        // 1. Find the cart item
        const cartItem = await ctx.db.query.cartItem({
            where: {
                id: args.id
            }
        }, `{ id user {id} }`)
        if (!cartItem) throw new Error('No cart item found!')
        // 2. Make sure they own that cart item
        if (cartItem.user.id !== ctx.request.userId) {
            throw new Error('Cheating huh?')
        }
        // 3. Delete cart item
        return ctx.db.mutation.deleteCartItem({
            where: { id: args.id}
        }, info)
    },
    async createOrder(parent, args, ctx, info) {
        // 1. Query the current user and make sure they are signed in
        const { userId } = ctx.request
        if (!userId) {
            throw new Error('You must be signed in to complete this order!')
        }
        const user = await ctx.db.query.user({where: {id: userId}}, `{id name email cart {id quantity item {id title description image largeImage price}}}`)
        // 2. Recalculate the total for the price
        const amount = user.cart.reduce((tally, cartItem) => tally + cartItem.item.price * cartItem.quantity, 0)
        console.log(`Going to charge for a total of ${amount}`)
        // 3. Create the Stripe charge
        const charge = await stripe.charges.create({
            amount,
            currency: 'USD',
            source: args.token
        })
        // 4. Convert the CartItems to OrderItems
        const orderItems = user.cart.map(cartItem => {
            const orderItem = {
                ...cartItem.item,
                quantity: cartItem.quantity,
                user: { connect: { id: userId }}
            }
            delete orderItem.id
            return orderItem
        })
        // 5. Create the Order
        const order = ctx.db.mutation.createOrder({
            data: {
                total: charge.amount,
                charge: charge.id,
                items: { create: orderItems },
                user: { connect: { id: userId }}
            }
        })
        // 6. Clean up - clear the user's cart, delete cartItems
        const cartItemIds = user.cart.map(cartItem => cartItem.id)
        await ctx.db.mutation.deleteManyCartItems({
            where: {
                id_in: cartItemIds
            }
        })
        // 7. Return the order to the client
        return order
    }
}

module.exports = Mutations
