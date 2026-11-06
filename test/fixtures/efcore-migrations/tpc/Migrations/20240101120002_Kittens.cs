using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Tpc.V2.Migrations
{
    /// <inheritdoc />
    public partial class Kittens : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<DateTime>(
                name: "Born",
                table: "Dogs",
                type: "TEXT",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "KeeperId",
                table: "Dogs",
                type: "INTEGER",
                nullable: true);

            migrationBuilder.AddColumn<DateTime>(
                name: "Born",
                table: "Cats",
                type: "TEXT",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "KeeperId",
                table: "Cats",
                type: "INTEGER",
                nullable: true);

            migrationBuilder.CreateTable(
                name: "Keepers",
                columns: table => new
                {
                    Id = table.Column<int>(type: "INTEGER", nullable: false)
                        .Annotation("Sqlite:Autoincrement", true),
                    Name = table.Column<string>(type: "TEXT", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Keepers", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "Kittens",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "TEXT", nullable: false),
                    Name = table.Column<string>(type: "TEXT", nullable: false),
                    Born = table.Column<DateTime>(type: "TEXT", nullable: true),
                    KeeperId = table.Column<int>(type: "INTEGER", nullable: true),
                    Lives = table.Column<int>(type: "INTEGER", nullable: false),
                    Mother = table.Column<string>(type: "TEXT", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Kittens", x => x.Id);
                    table.ForeignKey(
                        name: "FK_Kittens_Keepers_KeeperId",
                        column: x => x.KeeperId,
                        principalTable: "Keepers",
                        principalColumn: "Id");
                });

            migrationBuilder.CreateIndex(
                name: "IX_Dogs_KeeperId",
                table: "Dogs",
                column: "KeeperId");

            migrationBuilder.CreateIndex(
                name: "IX_Dogs_Name",
                table: "Dogs",
                column: "Name");

            migrationBuilder.CreateIndex(
                name: "IX_Cats_KeeperId",
                table: "Cats",
                column: "KeeperId");

            migrationBuilder.CreateIndex(
                name: "IX_Cats_Name",
                table: "Cats",
                column: "Name");

            migrationBuilder.CreateIndex(
                name: "IX_Kittens_KeeperId",
                table: "Kittens",
                column: "KeeperId");

            migrationBuilder.CreateIndex(
                name: "IX_Kittens_Name",
                table: "Kittens",
                column: "Name");

            migrationBuilder.AddForeignKey(
                name: "FK_Cats_Keepers_KeeperId",
                table: "Cats",
                column: "KeeperId",
                principalTable: "Keepers",
                principalColumn: "Id");

            migrationBuilder.AddForeignKey(
                name: "FK_Dogs_Keepers_KeeperId",
                table: "Dogs",
                column: "KeeperId",
                principalTable: "Keepers",
                principalColumn: "Id");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropForeignKey(
                name: "FK_Cats_Keepers_KeeperId",
                table: "Cats");

            migrationBuilder.DropForeignKey(
                name: "FK_Dogs_Keepers_KeeperId",
                table: "Dogs");

            migrationBuilder.DropTable(
                name: "Kittens");

            migrationBuilder.DropTable(
                name: "Keepers");

            migrationBuilder.DropIndex(
                name: "IX_Dogs_KeeperId",
                table: "Dogs");

            migrationBuilder.DropIndex(
                name: "IX_Dogs_Name",
                table: "Dogs");

            migrationBuilder.DropIndex(
                name: "IX_Cats_KeeperId",
                table: "Cats");

            migrationBuilder.DropIndex(
                name: "IX_Cats_Name",
                table: "Cats");

            migrationBuilder.DropColumn(
                name: "Born",
                table: "Dogs");

            migrationBuilder.DropColumn(
                name: "KeeperId",
                table: "Dogs");

            migrationBuilder.DropColumn(
                name: "Born",
                table: "Cats");

            migrationBuilder.DropColumn(
                name: "KeeperId",
                table: "Cats");
        }
    }
}
