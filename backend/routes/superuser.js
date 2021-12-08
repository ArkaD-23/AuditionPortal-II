const { sequelize } = require('../models');
const fs = require('fs');
const path = require('path');
// const roundmodel = require('../models/roundmodel');
const eventlogger = require('./eventLogger')
const sendMail = require('../services/reportSender')
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
require('dotenv').config();
const {
    models:
    {
        users,
        dashmodel,
        roundmodel
    }
} = sequelize;
module.exports = (app, passport) => {
    require("../passport/passportjwt")(passport);
    require("../passport/passportgoogle")(passport);
    require("../passport/passportgithub")(passport);
    const authPass = passport.authenticate("jwt",
        {
            session: false
        }
    );


    app.put(
        "/protected/changerole",
        authPass,
        async (req, res) => {
            if (req.user.role === "su") {
                console.log(req.user);
                var role = req.body.role;
                const userDetails = await users.getUserById(req.body)
                userDetails.role = role;
                await userDetails.save();
                const details = await dashmodel.findOne({ where: { uid: req.body.uuid } });
                details.role = role;
                details.save();
                console.log(details)
                if (eventlogger(req.user, `changed the role for ${details.name} to ${role}`))
                    res.sendStatus(201).json({ success: "true" });
                else
                    res.sendStatus(500).json({ success: "false" });
            } else {
                res.sendStatus(401).json({ success: "failed" });;
            }
        }
    );

    app.put(
        "/protected/setclearance", authPass,
        async (req, res) => {
            try {
                if (req.user.role === "su") {
                    var id = req.body.uuid;
                    var clearance = req.body.clearance
                    const details = await users.getUserById(req.body);
                    details.clearance = clearance;
                    details.save();
                    if (eventlogger(req.user, `Set Clearance for ${details.username} to ${clearance}`))
                        res.sendStatus(202);
                    else
                        res.sendStatus(500)
                } else {
                    res.sendStatus(401);
                }
            } catch (err) {
                console.log(err);
                return res.sendStatus(401);
            }
        }
    )

    app.post(
        "/protected/pushround", authPass,
        async (req, res) => {
            if (req.user.role === "su") {
                let save = JSON.parse(
                    fs.readFileSync(
                        path.resolve(__dirname + "../../config/auditionConfig.json"),
                    )
                );
                save.round = save.round + 1;
                save.status = "ong";
                await roundmodel.findOne({ where: { roundNo: save.round } }).then((doc) => {
                    if (!doc) {
                        req.sendStatus(400);
                    } else {
                        save.time = doc.time;
                        if (eventlogger(req.user, `Pushed Round ${save.round}`)) {
                            save = JSON.stringify(save);
                            fs.writeFileSync(
                                path.resolve(__dirname + "../../config/auditionConfig.json"),
                                save
                            );
                            res.sendStatus(200);
                        } else {
                            res.sendStatus(500)
                        }
                    }
                })
            } else {
                res.sendStatus(401);
            }
        }
    )


    app.post(
        "/protected/stopround",
        authPass,
        async (req, res) => {
            if (req.user.role === "su") {
                let save = JSON.parse(
                    fs.readFileSync(
                        path.resolve(__dirname + "../../config/auditionConfig.json")
                    )
                );

                save.round = save.round;
                save.status = "def";
                if (eventlogger(req.user, `Stopped Round ${save.round}`)) {
                    save = JSON.stringify(save);
                    fs.writeFileSync(
                        path.resolve(__dirname + "../../config/auditionConfig.json"),
                        save
                    );
                    res.sendStatus(200);
                } else {
                    res.sendStatus(500)
                }

            } else {
                res.sendStatus(300);
            }
        }
    );

    app.put("/protected/extendtime", authPass, async (req, res) => {
        if (req.user.role === 'su') {
            let save = JSON.parse(
                fs.readFileSync(
                    path.resolve(__dirname + "../../config/auditionConfig.json")
                )
            );
            if (save.status === 'ong') {
                if (req.body.id === 'all') {
                    await dashmodel.findAll({ where: { round: save.round } }).then((document) => {
                        if (!document) {
                            res.sendStatus(404)
                        } else {
                            var mutabledoc = document
                            mutabledoc.forEach(async kid => {
                                if (kid.role === 's') {
                                    if (kid.time < (new Date().getTime()))
                                        kid.time = new Date().getTime() + 600000 + 2000;
                                    else
                                        kid.time += 600000;
                                    console.log(kid)
                                    const kidDash = await dashmodel.findOne({ where: { uid: kid.uid } });
                                    if (kidDash.time < (new Date().getTime()))
                                        kidDash.time = new Date().getTime() + 600000 + 2000;
                                    else
                                        kidDash.time += 600000;
                                    kidDash.save()
                                }
                            })
                        }
                    }).then(() => {
                        if (eventlogger(req.user, `Extended Time for everyone by 10 minutes`))
                            res.sendStatus(202)
                        else
                            res.sendStatus(500)

                    })
                } else {
                    const kidItem = await dashmodel.findOne({ where: { uid: req.body.id } });
                    if (kidItem.time < (new Date().getTime()))
                        kidItem.time = new Date().getTime() + 600000 + 2000;
                    else
                        kidItem.time += 600000;
                    kidItem.save().then(() => {
                        if (eventlogger(req.user, `Extended Time for ${kidItem.name} by 10 minutes to ${new Date(kidItem.time).toString.substring(0, 24)}`))
                            res.sendStatus(202)
                        else
                            res.sendStatus(500)
                    })
                }
            } else res.sendStatus(401)
        } else res.sendStatus(401)
    })


    app.post(
        "/protected/pushresult",
        authPass,
        async (req, res) => {
            if (req.user.role === "su") {
                let save = JSON.parse(
                    fs.readFileSync(
                        path.resolve(__dirname + "../../config/auditionConfig.json")
                    )
                );
                var round = save.round
                save = JSON.stringify({
                    round: save.round,
                    status: "res",
                });
                var csvobject = []
                var rejected = "";
                // This route is unstable due to this check...
                await dashmodel.findOne({ where : [[{ status : "review"},{status: "unevaluated"}],[{role: 's'},{round: Number(round)}]]}).then(async (userdoc) => {
                // await dashmodel.findOne({ $or: [{ status: "review" }, { status: "unevaluated" }], $and: [{ role: 's' }, { round: Number(round) }] }).then((userdoc) => {
                    console.log(userdoc)
                    if (!userdoc.length) {
                        fs.closeSync(fs.openSync(path.resolve(__dirname + `../../result/Result_${round}.csv`), 'w'))
                        fs.writeFileSync(
                            path.resolve(__dirname + "../../config/auditionConfig.json"),
                            save
                        );
                        await dashmodel.findAll()
                            .then((doc) => {
                                doc.forEach(async (user) => {
                                    if (user.status === "rejected" && user.round === round) {
                                        rejected += user.email + ",";
                                    } else if (user.status === "selected" && user.round === round) {
                                        csvobject.push(user)
                                        const doc2 = await dashmodel.findOne({ where: { uid: user._id } })
                                        doc2.status = "unevaluated";
                                        doc2.round += 1;
                                        doc2.time = 0;
                                        doc2.save();
                                        sendMail(
                                            "Congratulations!",
                                            `<html>Hi <b>${user.name}.</b><br/><br/>
                        We are glad to inform you that you were shortlisted in <b>Round ${round}.</b><br/>
                        You will be moving ahead in the audition process.<br/>
                        Further details will be let known very soon.<br/><br/>
                        Join our Whatsapp All in Group here: ${process.env.WHATSAPP} if you haven't joined yet.<br/><br/>
                        All latest updates will come there first!<br/><br/>
                        Make sure you join the GLUG ALL-IN server for the next rounds of the audition process.<br/>
                        Join here: ${process.env.DISCORD}<br/><br/>
                        Make sure that you set your server nick-name as your real name alongwith your complete roll number.<br/>
                        If your name is ABCD and Roll number is 20XX800XX, your username should be ABCD_20XX800XX.<br/><br/>
                        May The Source Be With You!🐧❤️<br/><br/>
                        Thanking You,<br/>
                        Your's Sincerely,<br/>
                        <b>GNU/Linux Users' Group, NIT Durgapur.</b></html>`,
                                            user.email
                                        );
                                    }
                                });
                            })
                            .then(() => {
                                const csvWriter = createCsvWriter({
                                    path: path.resolve(__dirname + `../../result/Result_${round}.csv`),
                                    header: [
                                        { id: 'name', title: 'Name' },
                                        { id: 'email', title: 'Email' },
                                        { id: 'phone', title: 'Phone' },
                                    ]
                                });

                                csvWriter
                                    .writeRecords(csvobject)
                                    .then(() => console.log('The CSV file was written successfully'));

                                const rejectedones = rejected.slice(0, -1);
                                sendMail(
                                    "Thank you for your participation.",
                                    "<html>Hi there.<br/>We announce with a heavy heart that you will not be moving ahead in the audition process.<br/><br/>However, the GNU/Linux User's Group will always be there to help your every need to the best of our abilities.<br/>May The Source Be With You!<br/><br/>Thanking You,<br/>Yours' Sincerely,<br/>GNU/Linux Users' Group, NIT Durgapur.</html>",
                                    rejectedones
                                );
                            })
                            .then(() => {
                                if (eventlogger(req.user, `Result pushed for round ${round}`))
                                    return res.status(201).send({ status: true });
                                else
                                    res.sendStatus(500)
                            })
                    } else {
                        res.status(200).send({ status: false })
                    }
                })

            } else {
                res.sendStatus(401);
            }
        }
    );

    app.get("/profile", authPass, async (req, res) => {
        if (req.user.role === "s") {
            await dashmodel.findOne({ where: { uid: req.user._id } }).then(doc => {
                res.status(200).json({ phone: doc.phone, roll: doc.roll, profilebool: doc.profilebool })
            })
        }
    })

    app.get("/getResult", async (req, res) => {
        let save = JSON.parse(
            fs.readFileSync(
                path.resolve(__dirname + "../../config/auditionConfig.json")
            )
        );

        if (save.status === "res") {
            var result = []
            await dashmodel.findAll({ where: { status: "unevaluated", round: save.round + 1 } }).then((doc) => {
                doc.forEach((kid) => {
                    result.push(kid.name)
                })
            }).then(() => {
                res.status(200).send(result)
            })
        }
        else {
            var result = []
            await dashmodel.find({ where: { status: "unevaluated", round: save.round } }).then((doc) => {
                doc.forEach((kid) => {
                    result.push(kid.name)
                })
            }).then(() => {
                res.status(200).send(result)
            })
        }
    })

    app.get("/auditionstatus", (req, res) => {
        res.sendFile(path.join(__dirname + "../../config/auditionConfig.json"));
    });

};