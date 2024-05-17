const functions = require('firebase-functions');
const admin = require('firebase-admin');
const moment = require('moment-timezone');
const Razorpay = require('razorpay');
const crypto = require('crypto');
admin.initializeApp();

const razorpay = new Razorpay({
    key_id: functions.config().razorpay.key_id,
    key_secret: functions.config().razorpay.key_secret
});

exports.createOrder = functions.https.onRequest(async (request, response) => {
    if (request.method !== 'POST') {
        return response.status(405).send('Method Not Allowed');
    }

    if (request.get('content-type') !== 'application/json') {
        return response.status(400).send('Bad Request: Expected JSON');
    }

    try {
        // Ensure the amount is provided in the request body and is a number
        if (!request.body.amount || typeof request.body.amount !== 'number') {
            throw new Error('The request must contain an "amount" field with a number value.');
        }

        // Razorpay expects the amount in the smallest currency unit (e.g., paise for INR)
        const amountInPaise = request.body.amount * 100;
        const options = {
            amount: amountInPaise,
            currency: "INR",
            receipt: `receipt#${Date.now()}`
        };
        const order = await razorpay.orders.create(options);
        response.json(order);
    } catch (error) {
        console.error('Error creating Razorpay order:', error);
        response.status(500).send(`Error creating order: ${error.message}`);
    }
});

exports.verifyPayment = functions.https.onRequest((request, response) => {
    const {
        razorpay_order_id,
        razorpay_payment_id,
        razorpay_signature
    } = request.body;

    const secret = functions.config().razorpay.key_secret;

    const shasum = crypto.createHmac('sha256', secret);
    shasum.update(`${razorpay_order_id}|${razorpay_payment_id}`);
    const digest = shasum.digest('hex');

    if (digest !== razorpay_signature) {
        response.status(400).send('Payment verification failed');
        return;
    }
    response.status(200).send({ success: true });
});

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
    .onCreate(async (snap, context) => {
        const order = snap.data()

        // Check if the runner reference exists and dereference it
        if (order.runner) {
            try {
                const runnerRef = order.runner
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
                            screen: 'OrderDetailsScreen',  // Ensure this is handled in your navigation structure
                            orderId: context.params.orderId  // Pass orderId to handle specific navigation
                        },
                        token: runnerData.fcmToken,  // Use the FCM token string
                    }

                    // Send the notification to the runner's device
                    const response = await admin.messaging().send(message)
                    if (response) {
                        console.log(`Notification sent successfully to the device.`)
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
            console.log('Runner field is not populated in the order document.')
        }
        return null
    })

exports.assignRunnerOnOrderReady = functions.firestore
    .document('orders/{orderId}')
    .onUpdate(async (change, context) => {
        const before = change.before.data();
        const after = change.after.data();

        // Proceed only if the order status has changed to 'ready' and no runner is assigned
        if (after.orderStatus === 'ready' && before.orderStatus !== 'ready' && !after.runner) {
            const runner = await findLeastBusyRunner();
            if (runner) {
                return change.after.ref.update({
                    runner: runner.ref,
                    waitingForRunner: admin.firestore.FieldValue.delete()
                });
            } else {
                return change.after.ref.update({ waitingForRunner: true });
            }
        }
        return null;
    });

async function findLeastBusyRunner() {
    const runnersQuerySnapshot = await admin.firestore().collection('runners')
        .where('isActive', '==', true)
        .orderBy('completedOrders', 'asc') // First order by the least number of completedOrders
        .orderBy('activeOrders', 'asc') // Then by the least number of activeOrders
        .limit(1)
        .get();
    return runnersQuerySnapshot.empty ? null : runnersQuerySnapshot.docs[0];
}


async function findActiveRunner() {
    const runnerQuerySnapshot = await admin.firestore().collection('runners')
        .where('isActive', '==', true)
        .limit(1)
        .get();
    return runnerQuerySnapshot.empty ? null : runnerQuerySnapshot.docs[0];
}

exports.assignOrdersWhenRunnerActivates = functions.firestore
    .document('runners/{runnerId}')
    .onUpdate(async (change, context) => {
        const before = change.before.data();
        const after = change.after.data();

        // Proceed only if a runner's isActive status changes to true
        if (before.isActive !== after.isActive && after.isActive === true) {
            const orders = await admin.firestore().collection('orders')
                .where('waitingForRunner', '==', true)
                .get();
            if (!orders.empty) {
                const batch = admin.firestore().batch();
                let count = 0;
                orders.docs.forEach(doc => {
                    if (count < 5) { // Assuming a runner can handle up to 5 orders
                        batch.update(doc.ref, {
                            runner: change.after.ref,
                            waitingForRunner: admin.firestore.FieldValue.delete()
                        });
                        count++;
                    }
                });
                await batch.commit();
                return change.after.ref.update({
                    activeOrders: admin.firestore.FieldValue.increment(count),
                    isActive: count === 5 ? false : true
                });
            }
        }
        return null;
    });

exports.updateRunnerOnOrderDelivered = functions.firestore
    .document('orders/{orderId}')
    .onUpdate(async (change, context) => {
        const before = change.before.data();
        const after = change.after.data();

        // Proceed only if the order status changes to 'delivered'
        if (before.orderStatus !== 'delivered' && after.orderStatus === 'delivered' && after.runner) {
            const runnerRef = after.runner;
            const runnerDoc = await runnerRef.get();
            if (!runnerDoc.exists) {
                console.log('Runner document does not exist');
                return null;
            }

            const runnerData = runnerDoc.data();
            const decrement = runnerData.activeOrders > 0 ? 1 : 0;
            await runnerRef.update({
                activeOrders: admin.firestore.FieldValue.increment(-decrement),
                isActive: runnerData.activeOrders - decrement < 5
            });
        }
        return null;
    });

// Resets daily completed orders count
exports.resetDailyCompletedOrders = functions.pubsub.schedule('0 0 * * *')  // Every day at midnight
    .timeZone('America/New_York')  // Set according to your time zone
    .onRun((context) => {
        const resetBatch = admin.firestore().batch();
        const runnersRef = admin.firestore().collection('runners');
        return runnersRef.get().then(snapshot => {
            snapshot.forEach(doc => {
                resetBatch.update(doc.ref, { completedOrders: 0 });
            });
            return resetBatch.commit();
        });
    });

// Resets monthly completed orders count
exports.resetMonthlyCompletedOrders = functions.pubsub.schedule('0 0 1 * *')  // First of every month at midnight
    .timeZone('America/New_York')  // Set according to your time zone
    .onRun((context) => {
        const resetBatch = admin.firestore().batch();
        const runnersRef = admin.firestore().collection('runners');
        return runnersRef.get().then(snapshot => {
            snapshot.forEach(doc => {
                resetBatch.update(doc.ref, { totalCompletedOrders: 0 });
            });
            return resetBatch.commit();
        });
    });

exports.updateIsActive = functions.firestore
    .document('restaurants/{restaurantId}')
    .onUpdate((change, context) => {
        function isTimeInRange(now, from, until) {
            const nowTime = now.hours() * 60 + now.minutes();
            const fromTime = timeStringToMinutes(from);
            const untilTime = timeStringToMinutes(until);

            return nowTime >= fromTime && nowTime <= untilTime;
        }

        function timeStringToMinutes(timeString) {
            const [hours, minutes] = timeString.split(':').map(Number);
            return hours * 60 + minutes;
        }

        const newAvailability = change.after.data().availability.general;
        console.log('newAvailability:', newAvailability);

        const now = moment.tz('Asia/Kolkata'); // Set the timezone to IST
        console.log('now:', now.format());

        const dayOfWeek = now.format('dddd').toLowerCase(); // Get the day name in lowercase
        console.log('dayOfWeek:', dayOfWeek);

        const currentDay = newAvailability[dayOfWeek];
        console.log('currentDay:', currentDay);

        if (!currentDay || !currentDay.isOpen) {
            // If isOpen is false, set isActive to false
            return change.after.ref.update({
                isActive: false
            });
        } else {
            // If isOpen is true, check the time range
            if (isTimeInRange(now, currentDay.from, currentDay.until)) {
                return change.after.ref.update({
                    isActive: true
                });
            } else {
                return change.after.ref.update({
                    isActive: false
                });
            }
        }
    });