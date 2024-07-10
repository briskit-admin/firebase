const functions = require('firebase-functions')
const admin = require('firebase-admin')
const moment = require('moment-timezone')
const Razorpay = require('razorpay')
const crypto = require('crypto')
const { SecretManagerServiceClient } = require('@google-cloud/secret-manager')

admin.initializeApp()

const adminPhoneNumber = '9884713398'
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

    return { twilioClient, razorpay, razorpayKeySecret }
}

async function sendSMS(to, body) {
    const { twilioClient } = await initializeServices()
    const formattedTo = `+91${to}`
    try {
        await twilioClient.messages.create({
            body: body,
            from: twilioPhoneNumber,
            to: formattedTo
        })
        console.log('SMS sent successfully')
    } catch (error) {
        console.error('Failed to send SMS', error)
    }
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
        const { razorpay, razorpayKeySecret } = await initializeServices()

        const {
            razorpay_order_id,
            razorpay_payment_id,
            razorpay_signature
        } = request.body
        console.log('Razorpay Key Secret:', razorpay)
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

            const restaurantData = restaurantDoc.data()
            const restaurantName = restaurantData.name || 'Unknown Restaurant'
            const restaurantBranch = restaurantData.branch || 'Unknown Branch'
            
            // Fetch customer details
            const customerRef = order.customer
            const customerDoc = await customerRef.get()

            if (!customerDoc.exists) {
                console.log('No such customer!')
                return null
            }

            const customerData = customerDoc.data()
            const customerName = customerData.name || 'Unknown Customer'

            // Parse and adjust delivery time
            const deliveryTime = order.deliveryTime
            const [hours, minutes] = deliveryTime.split(':').map(Number)
            const deliveryDate = new Date()
            deliveryDate.setHours(hours)
            deliveryDate.setMinutes(minutes)
            deliveryDate.setMinutes(deliveryDate.getMinutes() - 30)
            const adjustedHours = String(deliveryDate.getHours()).padStart(2, '0')
            const adjustedMinutes = String(deliveryDate.getMinutes()).padStart(2, '0')
            const adjustedDeliveryTime = `${adjustedHours}:${adjustedMinutes}`

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
                        body: `Customer: ${customerName}\nDeliver by: ${adjustedDeliveryTime}`,
                    },
                    android: {
                        notification: {
                            icon: "ic_custom_notification",
                        }
                    },
                    data: {
                        screen: 'OrderListScreen',  
                        orderId: context.params.orderId 
                    },
                    tokens,
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

                // Fetch restaurant details
                const restaurantRef = after.restaurant
                const restaurantDoc = await restaurantRef.get()

                if (!restaurantDoc.exists) {
                    console.log('No such restaurant!')
                    return null
                }

                const restaurantData = restaurantDoc.data()
                const restaurantName = restaurantData.name || ''
                const restaurantBranch = restaurantData.branch || ''

                // Parse and adjust delivery time
                const deliveryTime = after.deliveryTime
                const [hours, minutes] = deliveryTime.split(':').map(Number)
                const deliveryDate = new Date()
                deliveryDate.setHours(hours)
                deliveryDate.setMinutes(minutes)
                deliveryDate.setMinutes(deliveryDate.getMinutes() - 15)
                const adjustedHours = String(deliveryDate.getHours()).padStart(2, '0')
                const adjustedMinutes = String(deliveryDate.getMinutes()).padStart(2, '0')
                const adjustedDeliveryTime = `${adjustedHours}:${adjustedMinutes}`

                // Check if there is an FCM token to send the notification to
                if (runnerData.fcmToken) {
                    const message = {
                        notification: {
                            title: 'New Order Assigned',
                            body: `Restaurant: ${restaurantName}${restaurantBranch ? `, ${restaurantBranch}` : ''}\nDeliver before: ${adjustedDeliveryTime}`,
                        },
                        android: {
                            notification: {
                                icon: "ic_custom_notification",
                            }
                        },
                        data: {
                            screen: 'OrderDetailScreen',
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
        if (!order.runner) {
            const runner = await findSuitableRunner(order.deliveryTime)
            if (runner) {
                await snapshot.ref.update({
                    runner: runner.ref,
                    waitingForRunner: admin.firestore.FieldValue.delete()
                })
                await runner.ref.update({
                    activeOrders: admin.firestore.FieldValue.increment(1),
                    orders: admin.firestore.FieldValue.arrayUnion(snapshot.ref)
                })
            } else {
                await snapshot.ref.update({ waitingForRunner: true })
                // Send SMS to admin about no available runner
                await sendSMS(adminPhoneNumber, 'No runner available for order#' + order.orderNum)
            }
        }
    })

exports.onRunnerAssignedToOrder = functions.firestore
    .document('orders/{orderId}')
    .onUpdate(async (change, context) => {
        const before = change.before.data()
        const after = change.after.data()

        if (!before.runner && after.runner) {
            // Runner has been assigned
            const runnerRef = after.runner
            await runnerRef.update({
                activeOrders: admin.firestore.FieldValue.increment(1),
                orders: admin.firestore.FieldValue.arrayUnion(change.after.ref)
            })
            await change.after.ref.update({
                waitingForRunner: admin.firestore.FieldValue.delete()
            })
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

// Firestore trigger for order creation
exports.sendOrderCreationSMS = functions.firestore
.document('orders/{orderId}')
.onCreate(async (snap, context) => {
    const order = snap.data()
    const customerRef = order.customer

    try {
        const customerDoc = await customerRef.get()
        if (customerDoc.exists) {
            const customerData = customerDoc.data()
            const customerMobile = customerData.mobile
            const message = `Your BriskIT order with order#${order.orderNum} and Pickup Code: ${order.pickupCode} has been received`
            await sendSMS(customerMobile, message)
        } else {
            console.log('Customer document does not exist.')
        }
    } catch (error) {
        console.error('Error fetching customer document:', error)
    }
})

// Firestore trigger for order status updates
exports.sendOrderStatusUpdateSMS = functions.firestore
.document('orders/{orderId}')
.onUpdate(async (change, context) => {
    const before = change.before.data()
    const after = change.after.data()
    const customerRef = after.customer

    let message = ''

    if (before.orderStatus !== after.orderStatus) {
        try {
            const customerDoc = await customerRef.get()
            if (customerDoc.exists) {
                const customerData = customerDoc.data()
                const customerMobile = customerData.mobile

                switch (after.orderStatus) {
                    case 'delivered':
                        message = `Your BriskIT order with order#${after.orderNum} has been delivered. Please visit the pickup point and collect your order`
                        break
                    case 'completed':
                        message = `Your BriskIT order with order#${after.orderNum} has been picked up`
                        break
                    case 'cancelled':
                        message = `Your BriskIT order with order#${after.orderNum} has been cancelled`
                        break
                }
                if (message) {
                    await sendSMS(customerMobile, message)
                }
            } else {
                console.log('Customer document does not exist.')
            }
        } catch (error) {
            console.error('Error fetching customer document:', error)
        }
    }
})