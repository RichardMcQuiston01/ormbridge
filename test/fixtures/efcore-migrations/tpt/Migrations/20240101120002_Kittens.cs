using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Tpt.V2.Migrations
{
    /// <inheritdoc />
    public partial class Kittens : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<int>(
                name: "TrainerId",
                table: "Dogs",
                type: "INTEGER",
                nullable: true);

            migrationBuilder.AddColumn<bool>(
                name: "Indoor",
                table: "Cats",
                type: "INTEGER",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<string>(
                name: "Note",
                table: "Animals",
                type: "TEXT",
                nullable: true);

            migrationBuilder.CreateTable(
                name: "Kittens",
                columns: table => new
                {
                    Id = table.Column<int>(type: "INTEGER", nullable: false)
                        .Annotation("Sqlite:Autoincrement", true),
                    Mother = table.Column<string>(type: "TEXT", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Kittens", x => x.Id);
                    table.ForeignKey(
                        name: "FK_Kittens_Cats_Id",
                        column: x => x.Id,
                        principalTable: "Cats",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "Trainers",
                columns: table => new
                {
                    Id = table.Column<int>(type: "INTEGER", nullable: false)
                        .Annotation("Sqlite:Autoincrement", true),
                    Name = table.Column<string>(type: "TEXT", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Trainers", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_Dogs_TrainerId",
                table: "Dogs",
                column: "TrainerId");

            migrationBuilder.AddForeignKey(
                name: "FK_Dogs_Trainers_TrainerId",
                table: "Dogs",
                column: "TrainerId",
                principalTable: "Trainers",
                principalColumn: "Id");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropForeignKey(
                name: "FK_Dogs_Trainers_TrainerId",
                table: "Dogs");

            migrationBuilder.DropTable(
                name: "Kittens");

            migrationBuilder.DropTable(
                name: "Trainers");

            migrationBuilder.DropIndex(
                name: "IX_Dogs_TrainerId",
                table: "Dogs");

            migrationBuilder.DropColumn(
                name: "TrainerId",
                table: "Dogs");

            migrationBuilder.DropColumn(
                name: "Indoor",
                table: "Cats");

            migrationBuilder.DropColumn(
                name: "Note",
                table: "Animals");
        }
    }
}
