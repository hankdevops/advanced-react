const { forwardTo } = require('prisma-binding')
const { hasPermission } = require('../utils')
const { createOrder } = require('./Mutation')

const Query = {
    items: forwardTo('db'),
    item: forwardTo('db'),
    itemsConnection: forwardTo('db'),
    me(parent, args, ctx, info) {
        if(!ctx.request.userId) {
            return null
        }
        return ctx.db.query.user({
            where: { id: ctx.request.userId}
        }, info)
    },
    async users(parent, args, ctx, info) {
        if (!ctx.request.userId) {
            throw new Error('You must be logged in!')
        }
        // 1. Check if the user has the permissions to query all the users
        hasPermission(ctx.request.user, ['ADMIN', 'PERMISSIONUPDATE'])
        // 2. If they do, query all the users
        return ctx.db.query.users({}, info)
    },
    async order(parent, args, ctx, info) {
        if (!ctx.request.userId) {
            throw new Error('You are not logged in!')
        }
        const order = await ctx.db.query.order({
            where: {id: args.id}
        }, info)
        const ownsOrder = order.user.id === ctx.request.userId
        console.log('ownsOrder: ' + ownsOrder)
        const hasPermissionToSeeOrder = ctx.request.user.permissions.includes('ADMIN')
        console.log('hasPermissionToSeeOrder: ' + hasPermissionToSeeOrder)
        if (!ownsOrder || !hasPermissionToSeeOrder) {
            throw new Error('You cannot see this, budddd')
        }
        return order
    }
}

module.exports = Query
