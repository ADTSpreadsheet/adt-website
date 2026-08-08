"use strict";

// =========================================================
// ADTSpreadsheet Website API
// File: routes/seminar-pilefix-api.js
//
// PURPOSE:
// ประตู 02 : ผู้ถือครอง ADT-PILEFiX Professional
//
// FLOW:
// 1) POST /verify
//    - รับ booking_no เช่น PF-038
//    - ตรวจสิทธิ์จากตาราง reservations
//
// 2) POST /confirm
//    - ตรวจสิทธิ์จาก reservations ซ้ำอีกครั้ง
//    - บันทึกข้อมูลลง 05_seminar_pilefix_registrations
//    - ส่ง Zoom + Password ให้ลูกค้าทาง LINE
//    - ส่ง Success Report ให้ Admin
//    - ตอบหน้าเว็บเมื่อดำเนินการแล้ว
//
// IMPORTANT:
// - ไม่มี Payment
// - ไม่มี Slip
// - ไม่มี OCR
// - ไม่มี AP / RJ
// - กด Confirm หลัง Verify ผ่าน = อนุมัติสิทธิ์สัมมนา
// =========================================================

const express = require("express");


// =========================================================
// SETTINGS
// =========================================================

const SOURCE_TABLE =
  "reservations";

const TARGET_TABLE =
  "05_seminar_pilefix_registrations";

const SEMINAR_CODE =
  "ADT-PILEFIX-20260809";


// สถานะของผู้ถือโปรแกรมที่ถือว่า "มีสิทธิ์"
// ปรับเพิ่ม/ลดได้ตามค่าจริงใน reservations
const ELIGIBLE_STATUSES =
  new Set([
    "APPROVED",
    "ACTIVE",
    "ACTIVATED",
    "PAID"
  ]);


// =========================================================
// MODULE
// =========================================================

module.exports = function seminarPilefixApiRoutes({
  reservationsSupabase,
  seminarSupabase
}) {

  if (!reservationsSupabase) {
    throw new Error(
      "reservationsSupabase is required"
    );
  }

  if (!seminarSupabase) {
    throw new Error(
      "seminarSupabase is required"
    );
  }

  const router =
    express.Router();

  router.use(
    express.json({
      limit:
        "100kb"
    })
  );


  // =======================================================
  // HELPERS
  // =======================================================

  function normalizeBookingNo(value) {

    let bookingNo =
      String(
        value || ""
      )
        .trim()
        .toUpperCase()
        .replace(
          /\s+/g,
          ""
        );


    if (
      /^\d+$/.test(
        bookingNo
      )
    ) {

      bookingNo =
        "PF-" +
        bookingNo;
    }


    if (
      /^PF\d+$/.test(
        bookingNo
      )
    ) {

      bookingNo =
        bookingNo.replace(
          /^PF/,
          "PF-"
        );
    }


    return bookingNo;
  }


  function getFullName(
    reservation
  ) {

    const direct =
      String(
        reservation?.full_name ||
        ""
      ).trim();

    if (direct) {
      return direct;
    }


    const first =
      String(
        reservation?.first_name ||
        ""
      ).trim();

    const last =
      String(
        reservation?.last_name ||
        ""
      ).trim();


    return (
      `${first} ${last}`
    ).trim();
  }


  function isEligibleReservation(
    reservation
  ) {

    if (!reservation) {
      return false;
    }


    const status =
      String(
        reservation.status ||
        reservation.payment_status ||
        ""
      )
        .trim()
        .toUpperCase();


    /*
      ถ้าใน reservations ไม่มี status
      แต่ row มีอยู่จริงและมี line_user_id
      ยังไม่ให้ผ่านอัตโนมัติ เพื่อความปลอดภัย
    */
    if (!status) {
      return false;
    }


    return ELIGIBLE_STATUSES.has(
      status
    );
  }


  async function findReservation(
    bookingNo
  ) {

    const {
      data,
      error
    } =
      await reservationsSupabase
        .from(
          SOURCE_TABLE
        )
        .select(`
          id,
          booking_no,
          full_name,
          phone,
          email,
          line_user_id,
          status
        `)
        .eq(
          "booking_no",
          bookingNo
        )
        .maybeSingle();


    if (error) {

      console.error(
        "[SEMINAR PILEFIX] Reservation lookup error:",
        error
      );

      return {
        success: false,
        reason:
          "RESERVATION_LOOKUP_FAILED",
        reservation:
          null
      };
    }


    if (!data) {

      return {
        success: false,
        reason:
          "PILEFIX_RIGHT_NOT_FOUND",
        reservation:
          null
      };
    }


    if (
      !isEligibleReservation(
        data
      )
    ) {

      return {
        success: false,
        reason:
          "PILEFIX_RIGHT_NOT_ELIGIBLE",
        reservation:
          data
      };
    }


    if (
      !String(
        data.line_user_id ||
        ""
      ).trim()
    ) {

      return {
        success: false,
        reason:
          "LINE_USER_NOT_FOUND",
        reservation:
          data
      };
    }


    return {
      success: true,
      reason:
        null,
      reservation:
        data
    };
  }


  // =======================================================
  // OUTBOUND : LINE BOT CUSTOMER ACCESS
  // =======================================================

  async function sendCustomerAccess(
    payload
  ) {

    const url =
      String(
        process.env.LINE_BOT_SEMINAR_ACCESS_URL ||
        ""
      ).trim();

    const secret =
      String(
        process.env.LINE_BOT_API_SECRET ||
        ""
      ).trim();


    if (!url) {

      return {
        success: false,
        reason:
          "LINE_BOT_ACCESS_URL_MISSING"
      };
    }


    try {

      const response =
        await fetch(
          url,
          {
            method:
              "POST",

            headers: {
              "Content-Type":
                "application/json",

              "X-Bot-API-Secret":
                secret
            },

            body:
              JSON.stringify(
                payload
              ),

            signal:
              AbortSignal.timeout(
                20000
              )
          }
        );


      if (!response.ok) {

        console.error(
          "[SEMINAR PILEFIX] LINE Bot HTTP error:",
          response.status
        );

        return {
          success: false,
          reason:
            `LINE_BOT_HTTP_${response.status}`
        };
      }


      return {
        success: true
      };

    }
    catch (error) {

      console.error(
        "[SEMINAR PILEFIX] LINE Bot request error:",
        error
      );


      return {
        success: false,
        reason:
          "LINE_BOT_REQUEST_FAILED"
      };
    }
  }


  // =======================================================
  // OUTBOUND : BOT ADMIN SUCCESS REPORT
  //
  // ประตู 02 ควรมี Endpoint ของตัวเอง
  // เช่น:
  // POST /api/seminar/pilefix/success-report
  // =======================================================

  async function sendAdminReport(
    payload
  ) {

    const url =
      String(
        process.env.BOT_ADMIN_PILEFIX_SUCCESS_URL ||
        ""
      ).trim();

    const secret =
      String(
        process.env.BOT_ADMIN_API_SECRET ||
        ""
      ).trim();


    if (!url) {

      return {
        success: false,
        reason:
          "BOT_ADMIN_PILEFIX_SUCCESS_URL_MISSING"
      };
    }


    try {

      const response =
        await fetch(
          url,
          {
            method:
              "POST",

            headers: {
              "Content-Type":
                "application/json",

              "X-Admin-API-Secret":
                secret
            },

            body:
              JSON.stringify(
                payload
              ),

            signal:
              AbortSignal.timeout(
                20000
              )
          }
        );


      if (!response.ok) {

        console.error(
          "[SEMINAR PILEFIX] Admin report HTTP error:",
          response.status
        );

        return {
          success: false,
          reason:
            `ADMIN_HTTP_${response.status}`
        };
      }


      return {
        success: true
      };

    }
    catch (error) {

      console.error(
        "[SEMINAR PILEFIX] Admin report request error:",
        error
      );


      return {
        success: false,
        reason:
          "ADMIN_REQUEST_FAILED"
      };
    }
  }


  // =======================================================
  // POST /verify
  // =======================================================

  router.post(
    "/verify",
    async (
      req,
      res
    ) => {

      try {

        const bookingNo =
          normalizeBookingNo(
            req.body?.booking_no
          );


        if (
          !/^PF-[A-Z0-9]+$/.test(
            bookingNo
          )
        ) {

          return res
            .status(400)
            .json({
              success: false,

              code:
                "INVALID_BOOKING_NO",

              message:
                "หมายเลข ADT-PILEFiX ไม่ถูกต้อง"
            });
        }


        const right =
          await findReservation(
            bookingNo
          );


        if (
          !right.success
        ) {

          const status =
            right.reason ===
              "PILEFIX_RIGHT_NOT_FOUND"
              ? 404
              : 403;


          return res
            .status(status)
            .json({
              success: false,

              code:
                right.reason,

              message:
                right.reason ===
                  "PILEFIX_RIGHT_NOT_FOUND"
                  ? "ไม่พบสิทธิ์ ADT-PILEFiX สำหรับหมายเลขนี้"
                  : "หมายเลขนี้ยังไม่มีสิทธิ์เข้าร่วมสัมมนาฟรี"
            });
        }


        const reservation =
          right.reservation;


        return res
          .status(200)
          .json({
            success: true,

            booking_no:
              reservation.booking_no,

            full_name:
              getFullName(
                reservation
              ),

            message:
              "ตรวจสอบสิทธิ์ ADT-PILEFiX สำเร็จ"
          });

      }
      catch (error) {

        console.error(
          "[SEMINAR PILEFIX] Verify error:",
          error
        );


        return res
          .status(500)
          .json({
            success: false,

            code:
              "SERVER_ERROR",

            message:
              "ไม่สามารถตรวจสอบสิทธิ์ได้"
          });
      }
    }
  );


  // =======================================================
  // POST /confirm
  //
  // กดปุ่ม "ยืนยันเข้าร่วมสัมมนา"
  // =======================================================

  router.post(
    "/confirm",
    async (
      req,
      res
    ) => {

      try {

        const bookingNo =
          normalizeBookingNo(
            req.body?.booking_no
          );


        if (
          !/^PF-[A-Z0-9]+$/.test(
            bookingNo
          )
        ) {

          return res
            .status(400)
            .json({
              success: false,

              code:
                "INVALID_BOOKING_NO",

              message:
                "หมายเลข ADT-PILEFiX ไม่ถูกต้อง"
            });
        }


        /*
          SECURITY:
          ไม่เชื่อผล Verify จากหน้าเว็บ
          Confirm ต้องย้อนตรวจ reservations ใหม่ทุกครั้ง
        */
        const right =
          await findReservation(
            bookingNo
          );


        if (
          !right.success
        ) {

          return res
            .status(403)
            .json({
              success: false,

              code:
                right.reason,

              message:
                "ไม่สามารถยืนยันสิทธิ์เข้าร่วมสัมมนาได้"
            });
        }


        const reservation =
          right.reservation;

        const nowIso =
          new Date()
            .toISOString();

        const fullName =
          getFullName(
            reservation
          );


        // ===============================================
        // 1. CHECK DUPLICATE
        // ===============================================

        const {
          data:
            existing,

          error:
            existingError
        } =
          await seminarSupabase
            .from(
              TARGET_TABLE
            )
            .select(`
              id,
              booking_no,
              registration_status,
              line_user_id
            `)
            .eq(
              "booking_no",
              bookingNo
            )
            .eq(
              "seminar_code",
              SEMINAR_CODE
            )
            .maybeSingle();


        if (existingError) {

          console.error(
            "[SEMINAR PILEFIX] Duplicate lookup error:",
            existingError
          );


          return res
            .status(500)
            .json({
              success: false,

              code:
                "REGISTRATION_LOOKUP_FAILED",

              message:
                "ไม่สามารถตรวจสอบข้อมูลการลงทะเบียนได้"
            });
        }


        /*
          ถ้าลงทะเบียนและส่งสิทธิ์แล้ว
          ไม่สร้างซ้ำ ไม่ส่ง Zoom ซ้ำ
        */
        if (
          existing &&
          String(
            existing.registration_status ||
            ""
          )
            .trim()
            .toUpperCase() ===
              "ACCESS_ISSUED"
        ) {

          return res
            .status(200)
            .json({
              success: true,

              registration_id:
                existing.id,

              booking_no:
                bookingNo,

              registration_status:
                "ACCESS_ISSUED",

              customer_access:
                "ALREADY_SENT",

              admin_report:
                "ALREADY_SENT",

              message:
                "หมายเลขนี้ลงทะเบียนสัมมนาเรียบร้อยแล้ว"
            });
        }


        // ===============================================
        // 2. INSERT / UPDATE TABLE 05
        //
        // NOTE:
        // ชื่อ Column ชุดนี้ต้องตรงกับ Table 05 จริง
        // ===============================================

        const registrationPayload = {

          seminar_code:
            SEMINAR_CODE,

          reservation_id:
            reservation.id,

          booking_no:
            reservation.booking_no,

          full_name:
            fullName,

          phone:
            reservation.phone ||
            null,

          email:
            reservation.email ||
            null,

          line_user_id:
            reservation.line_user_id,

          source_type:
            "PILEFIX",

          privilege_type:
            "ADT_PILEFIX_OWNER",

          price:
            0,

          registration_status:
            "CONFIRMED",

          confirmed_at:
            nowIso,

          updated_at:
            nowIso
        };


        let registration = null;


        if (existing) {

          const {
            data,
            error
          } =
            await seminarSupabase
              .from(
                TARGET_TABLE
              )
              .update(
                registrationPayload
              )
              .eq(
                "id",
                existing.id
              )
              .select("*")
              .single();


          if (error) {

            console.error(
              "[SEMINAR PILEFIX] Registration update error:",
              error
            );


            return res
              .status(500)
              .json({
                success: false,

                code:
                  "REGISTRATION_UPDATE_FAILED",

                message:
                  "บันทึกสิทธิ์สัมมนาไม่สำเร็จ"
              });
          }


          registration =
            data;

        }
        else {

          const {
            data,
            error
          } =
            await seminarSupabase
              .from(
                TARGET_TABLE
              )
              .insert(
                registrationPayload
              )
              .select("*")
              .single();


          if (error) {

            console.error(
              "[SEMINAR PILEFIX] Registration insert error:",
              error
            );


            return res
              .status(500)
              .json({
                success: false,

                code:
                  "REGISTRATION_INSERT_FAILED",

                message:
                  "บันทึกสิทธิ์สัมมนาไม่สำเร็จ"
              });
          }


          registration =
            data;
        }


        // ===============================================
        // 3. SEND CUSTOMER + ADMIN
        // ===============================================

        const [
          customerAccess,
          adminReport
        ] =
          await Promise.all([

            sendCustomerAccess({

              registration_id:
                registration.id,

              seminar_code:
                SEMINAR_CODE,

              source_type:
                "PILEFIX",

              approved_by:
                "ADT_PILEFIX_PRIVILEGE",

              booking_no:
                bookingNo,

              full_name:
                fullName,

              phone:
                reservation.phone,

              line_user_id:
                reservation.line_user_id
            }),


            sendAdminReport({

              registration_id:
                registration.id,

              seminar_code:
                SEMINAR_CODE,

              source_type:
                "PILEFIX",

              approved_by:
                "ADT_PILEFIX_PRIVILEGE",

              booking_no:
                bookingNo,

              full_name:
                fullName,

              phone:
                reservation.phone,

              amount:
                0,

              registration_status:
                "CONFIRMED",

              line_user_id:
                reservation.line_user_id
            })

          ]);


        console.log(
          "[SEMINAR PILEFIX] Dispatch result:",
          {
            booking_no:
              bookingNo,

            customer_access:
              customerAccess,

            admin_report:
              adminReport
          }
        );


        // ===============================================
        // 4. UPDATE ACCESS STATUS
        //
        // ลูกค้าได้ Zoom แล้ว = ACCESS_ISSUED
        // ===============================================

        if (
          customerAccess.success
        ) {

          const accessIssuedAt =
            new Date()
              .toISOString();


          const {
            error:
              accessUpdateError
          } =
            await seminarSupabase
              .from(
                TARGET_TABLE
              )
              .update({

                registration_status:
                  "ACCESS_ISSUED",

                access_issued_at:
                  accessIssuedAt,

                updated_at:
                  accessIssuedAt
              })
              .eq(
                "id",
                registration.id
              );


          if (
            accessUpdateError
          ) {

            console.error(
              "[SEMINAR PILEFIX] ACCESS_ISSUED update error:",
              accessUpdateError
            );
          }
        }


        // ===============================================
        // 5. RESPONSE
        // ===============================================

        return res
          .status(200)
          .json({
            success: true,

            registration_id:
              registration.id,

            booking_no:
              bookingNo,

            full_name:
              fullName,

            registration_status:
              customerAccess.success
                ? "ACCESS_ISSUED"
                : "CONFIRMED",

            customer_access:
              customerAccess.success
                ? "SENT"
                : "PENDING",

            admin_report:
              adminReport.success
                ? "SENT"
                : "PENDING",

            message:
              customerAccess.success
                ? "ลงทะเบียนสำเร็จ ระบบได้ส่งลิงก์ Zoom และรหัสผ่านไปยัง LINE แล้ว"
                : "บันทึกสิทธิ์แล้ว ระบบกำลังจัดส่งข้อมูลเข้าร่วมสัมมนา"
          });

      }
      catch (error) {

        console.error(
          "[SEMINAR PILEFIX] Confirm error:",
          error
        );


        return res
          .status(500)
          .json({
            success: false,

            code:
              "SERVER_ERROR",

            message:
              "เกิดข้อผิดพลาดภายในระบบ"
          });
      }
    }
  );


  // =======================================================
  // HEALTH
  // =======================================================

  router.get(
    "/health",
    (
      req,
      res
    ) => {

      return res
        .status(200)
        .json({
          success: true,

          service:
            "ADT Seminar PILEFiX Privilege",

          status:
            "RUNNING"
        });
    }
  );


  return router;
};
