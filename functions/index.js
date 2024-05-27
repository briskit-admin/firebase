const functions = require('firebase-functions')
const admin = require('firebase-admin')
const moment = require('moment-timezone')
const Razorpay = require('razorpay')
const crypto = require('crypto')
const { SecretManagerServiceClient } = require('@google-cloud/secret-manager')

admin.initializeApp()

const adminPhoneNumber = '+919884713398'
const twilioPhoneNumber = '+18482891608'

const secretClient = new SecretManagerServiceClient()

// Function to access secrets from Google Secret Manager
async function getSecret(name) {
    try {
        const [version] = await secretClient.accessSecretVersion({
            name: `projects/briskit-52b77/secrets/${name}/versions/latest`
        })
        return version.payload.data.toString('utf8')
    } catch (error) {
        console.error(`Failed to access secret ${name}`, error)
        throw error
    }
}

// Function to initialize services
async function initializeServices() {
    const accountSid = await getSecret('TWILIO_ACCOUNT_SID')
    const authToken = await getSecret('TWILIO_AUTH_TOKEN')
    const razorpayKeyId = await getSecret('RAZORPAY_KEY_ID')
    const razorpayKeySecret = await getSecret('RAZORPAY_KEY_SECRET')

    const twilioClient = new (require('twilio'))(accountSid, authToken)
    const razorpay = new Razorpay({
        key_id: razorpayKeyId,
        key_secret: razorpayKeySecret
    })

    return { twilioClient, razorpay }
}

exports.createOrder = functions.https.onRequest(async (request, response) => {
    try {
        const { razorpay } = await initializeServices()

        if (request.method !== 'POST') {
            return response.status(405).send('Method Not Allowed')
        }

        if (request.get('content-type') !== 'application/json') {
            return response.status(400).send('Bad Request: Expected JSON')
        }

        if (!request.body.amount || typeof request.body.amount !== 'number') {
            throw new Error('The request must contain an "amount" field with a number value.')
        }

        // Razorpay expects the amount in the smallest currency unit (e.g., paise for INR)
        const amountInPaise = request.body.amount * 100
        const options = {
            amount: amountInPaise,
            currency: "INR",
            receipt: `receipt#${Date.now()}`
        }
        const order = await razorpay.orders.create(options)
        response.json(order)
    } catch (error) {
        console.error('Error creating Razorpay order:', error)
        response.status(500).send(`Error creating order: ${error.message}`)
    }
})

exports.verifyPayment = functions.https.onRequest(async (request, response) => {
    try {
        const { razorpayKeySecret } = await initializeServices()

        const {
            razorpay_order_id,
            razorpay_payment_id,
            razorpay_signature
        } = request.body

        const shasum = crypto.createHmac('sha256', razorpayKeySecret)
        shasum.update(`${razorpay_order_id}|${razorpay_payment_id}`)
        const digest = shasum.digest('hex')

        if (digest !== razorpay_signature) {
            response.status(400).send('Payment verification failed')
            return
        }
        response.status(200).send({ success: true })
    } catch (error) {
        console.error('Error verifying payment:', error)
        response.status(500).send(`Error verifying payment: ${error.message}`)
    }
})

exports.sendRestaurantNotification = functions.firestore
    .document('orders/{orderId}')
    .onCreate(async (snap, context) => {
        const order = snap.data()
        console.log('Order data:', order)

        // Check if the restaurant reference exists and dereference it
        try {
            const restaurantRef = order.restaurant
            console.log('Restaurant reference:', restaurantRef.path)

            const restaurantDoc = await restaurantRef.get()  // Dereference the document

            if (!restaurantDoc.exists) {
                console.log('No such restaurant!')
                return null
            }

            const restaurantId = restaurantDoc.id  // Get the restaurant ID
            console.log('Restaurant ID:', restaurantId)

            // Fetch users associated with the restaurant
            const usersSnapshot = await admin.firestore()
                .collection('users')
                .where('restaurants', 'array-contains', restaurantRef)
                .get()

            if (usersSnapshot.empty) {
                console.log('No users found for the restaurant.')
                return null
            }

            // Collect all the fcmTokens
            const tokens = []
            usersSnapshot.forEach(userDoc => {
                const userData = userDoc.data()
                console.log('User data:', userData)
                if (userData.fcmToken) {
                    tokens.push(userData.fcmToken)
                }
            })

            if (tokens.length > 0) {
                const message = {
                    notification: {
                        title: 'New Order Received',
                        body: 'Tap to view the order.',
                    },
                    data: {
                        screen: 'OrderListScreen',  // Ensure this is handled in your navigation structure
                        orderId: context.params.orderId  // Pass orderId to handle specific navigation
                    },
                    tokens,  // Use the array of tokens
                }

                // Send a multicast message to all tokens registered to the restaurant users
                const response = await admin.messaging().sendMulticast(message)
                if (response.successCount > 0) {
                    console.log(`Notification sent successfully to ${response.successCount} devices.`)
                } else {
                    console.log('Failed to send any messages!')
                }
            } else {
                console.log('No FCM tokens found for the restaurant users.')
            }
        } catch (error) {
            console.error('Error sending notification:', error)
            return null
        }
    })

exports.sendRunnerNotification = functions.firestore
    .document('orders/{orderId}')
    .onUpdate(async (change, context) => {
        const before = change.before.data()
        const after = change.after.data()

        // Check if the runner field was added or changed
        if (!before.runner && after.runner) {
            try {
                const runnerRef = after.runner
                const runnerDoc = await runnerRef.get()

                if (!runnerDoc.exists) {
                    console.log('No such runner!')
                    return null
                }

                const runnerData = runnerDoc.data()

                // Check if there is an FCM token to send the notification to
                if (runnerData.fcmToken) {
                    const message = {
                        notification: {
                            title: 'New Order Assigned',
                            body: 'You have been assigned a new order. Tap to view the details.',
                        },
                        data: {
                            screen: 'OrderListScreen',
                            orderId: context.params.orderId
                        },
                        token: runnerData.fcmToken,
                    }

                    // Send the notification to the runner's device
                    const response = await admin.messaging().send(message)
                    if (response) {
                        console.log('Notification sent successfully to the device.')
                    } else {
                        console.log('Failed to send the message!')
                    }
                } else {
                    console.log('No FCM token found for the runner.')
                }
            } catch (error) {
                console.error('Error sending notification:', error)
                return null
            }
        } else {
            console.log('Runner field is not updated or not populated in the order document.')
        }
        return null
    })


exports.assignRunnerOnOrderCreated = functions.firestore
    .document('orders/{orderId}')
    .onCreate(async (snapshot, context) => {
        const order = snapshot.data()
        const runner = await findSuitableRunner(order.deliveryTime)
        if (runner) {
            await snapshot.ref.update({
                runner: runner.ref,
                waitingForRunner: admin.firestore.FieldValue.delete()
            })
            await runner.ref.update({
                activeOrders: admin.firestore.FieldValue.increment(1),
            })
        } else {
            await snapshot.ref.update({ waitingForRunner: true })
            // Send SMS to admin about no available runner
            await sendSMSToAdmin('No runner available for order ID: ' + order.orderNum)
        }
    })

async function findSuitableRunner(orderDeliveryTime) {
    const runnersSnapshot = await admin.firestore().collection('runners')
        .where('isActive', '==', true)
        .get()
    console.log('deliveryTIme:', orderDeliveryTime)
    if (runnersSnapshot.empty) return null

    const availableRunners = await Promise.all(runnersSnapshot.docs.map(async (doc) => {
        const runner = doc.data()
        const hasConflict = await runnerHasConflictingDelivery(doc.id, orderDeliveryTime)
        return hasConflict ? null : doc
    }))

    const filteredRunners = availableRunners.filter(runner => runner !== null)

    if (filteredRunners.length === 0) return null

    // Apply fair distribution logic here
    filteredRunners.sort((a, b) => {
        const runnerA = a.data()
        const runnerB = b.data()
        if (runnerA.activeOrders !== runnerB.activeOrders) {
            return runnerA.activeOrders - runnerB.activeOrders
        } else if (runnerA.completedOrders !== runnerB.completedOrders) {
            return runnerA.completedOrders - runnerB.completedOrders
        } else {
            return Math.random() - 0.5 // Random selection if both metrics are equal
        }
    })

    return filteredRunners[0]
}

async function runnerHasConflictingDelivery(runnerId, newDeliveryTime) {
    const [newHours, newMinutes] = newDeliveryTime.split(':').map(Number)
    const assignedOrdersSnapshot = await admin.firestore().collection('orders')
        .where('runner', '==', admin.firestore().doc(`runners/${runnerId}`))
        .where('orderStatus', 'in', ['received', 'ready', 'picked'])
        .get()

    return assignedOrdersSnapshot.docs.some(doc => {
        const order = doc.data()
        const [orderHours, orderMinutes] = order.deliveryTime.split(':').map(Number)

        const newTotalMinutes = newHours * 60 + newMinutes
        const orderTotalMinutes = orderHours * 60 + orderMinutes

        return Math.abs(newTotalMinutes - orderTotalMinutes) < 60 // Check if within 1 hour
    })
}

exports.updateRunnerOnOrderDelivered = functions.firestore
    .document('orders/{orderId}')
    .onUpdate(async (change, context) => {
        const before = change.before.data()
        const after = change.after.data()

        if (before.orderStatus !== 'delivered' && after.orderStatus === 'delivered' && after.runner) {
            const runnerRef = after.runner
            const runnerDoc = await runnerRef.get()
            if (!runnerDoc.exists) return null

            await runnerRef.update({
                activeOrders: admin.firestore.FieldValue.increment(-1),
                completedOrders: admin.firestore.FieldValue.increment(1),
                totalCompletedOrders: admin.firestore.FieldValue.increment(1)
            })
        }
        return null
    })

async function sendSMSToAdmin(message) {
    try {
        const { twilioClient } = await initializeServices()
        await twilioClient.messages.create({
            body: message,
            from: twilioPhoneNumber,
            to: adminPhoneNumber
        })
        console.log('SMS sent successfully')
    } catch (error) {
        console.error('Failed to send SMS', error)
    }
}


exports.resetDailyCompletedOrders = functions.pubsub.schedule('0 0 * * *')
    .timeZone('Asia/Kolkata')
    .onRun(async (context) => {
        const runnersRef = admin.firestore().collection('runners')
        const snapshot = await runnersRef.get()
        const resetBatch = admin.firestore().batch()
        snapshot.forEach(doc => {
            resetBatch.update(doc.ref, { completedOrders: 0 })
        })
        await resetBatch.commit()
    })

exports.resetMonthlyCompletedOrders = functions.pubsub.schedule('0 0 1 * *')
    .timeZone('Asia/Kolkata')
    .onRun(async (context) => {
        const runnersRef = admin.firestore().collection('runners')
        const snapshot = await runnersRef.get()
        const resetBatch = admin.firestore().batch()
        snapshot.forEach(doc => {
            resetBatch.update(doc.ref, { totalCompletedOrders: 0 })
        })
        await resetBatch.commit()
    })

exports.resetAvailability = functions.pubsub.schedule('0 5 * * *').timeZone('Asia/Kolkata').onRun(async (context) => {
    try {
        const restaurantsSnapshot = await admin.firestore().collection('restaurants').get()

        const batch = admin.firestore().batch()

        restaurantsSnapshot.forEach(restaurantDoc => {
            const menuRef = restaurantDoc.ref.collection('menu')
            menuRef.get().then(menuSnapshot => {
                menuSnapshot.forEach(itemDoc => {
                    batch.update(itemDoc.ref, { 'availability.isAvailable': true })
                })
            })
        })

        await batch.commit()
        console.log('Successfully reset availability for all items.')
    } catch (error) {
        console.error('Error resetting availability: ', error)
    }
})
