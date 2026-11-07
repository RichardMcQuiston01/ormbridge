using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace TptComposite.V1.Migrations
{
    /// <inheritdoc />
    public partial class Initial : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "Vehicles",
                columns: table => new
                {
                    Region = table.Column<string>(type: "TEXT", nullable: false),
                    Number = table.Column<int>(type: "INTEGER", nullable: false),
                    Plate = table.Column<string>(type: "TEXT", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Vehicles", x => new { x.Region, x.Number });
                });

            migrationBuilder.CreateTable(
                name: "Trucks",
                columns: table => new
                {
                    Region = table.Column<string>(type: "TEXT", nullable: false),
                    Number = table.Column<int>(type: "INTEGER", nullable: false),
                    Payload = table.Column<decimal>(type: "TEXT", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Trucks", x => new { x.Region, x.Number });
                    table.ForeignKey(
                        name: "FK_Trucks_Vehicles_Region_Number",
                        columns: x => new { x.Region, x.Number },
                        principalTable: "Vehicles",
                        principalColumns: new[] { "Region", "Number" },
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "Vans",
                columns: table => new
                {
                    Region = table.Column<string>(type: "TEXT", nullable: false),
                    Number = table.Column<int>(type: "INTEGER", nullable: false),
                    Seats = table.Column<int>(type: "INTEGER", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Vans", x => new { x.Region, x.Number });
                    table.ForeignKey(
                        name: "FK_Vans_Vehicles_Region_Number",
                        columns: x => new { x.Region, x.Number },
                        principalTable: "Vehicles",
                        principalColumns: new[] { "Region", "Number" },
                        onDelete: ReferentialAction.Cascade);
                });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "Trucks");

            migrationBuilder.DropTable(
                name: "Vans");

            migrationBuilder.DropTable(
                name: "Vehicles");
        }
    }
}
