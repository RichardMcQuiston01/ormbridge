using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Owned.V1.Migrations
{
    /// <inheritdoc />
    public partial class Initial : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "Customers",
                columns: table => new
                {
                    Id = table.Column<int>(type: "INTEGER", nullable: false)
                        .Annotation("Sqlite:Autoincrement", true),
                    Name = table.Column<string>(type: "TEXT", nullable: false),
                    Home_Street = table.Column<string>(type: "TEXT", maxLength: 120, nullable: false),
                    Home_City = table.Column<string>(type: "TEXT", nullable: true),
                    Home_Geo_Lat = table.Column<double>(type: "REAL", nullable: false),
                    Home_Geo_Lng = table.Column<double>(type: "REAL", nullable: false),
                    Work_Street = table.Column<string>(type: "TEXT", nullable: true),
                    Work_City = table.Column<string>(type: "TEXT", nullable: true),
                    Work_Geo_Lat = table.Column<double>(type: "REAL", nullable: true),
                    Work_Geo_Lng = table.Column<double>(type: "REAL", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Customers", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "Order",
                columns: table => new
                {
                    CustomerId = table.Column<int>(type: "INTEGER", nullable: false),
                    Id = table.Column<int>(type: "INTEGER", nullable: false),
                    Number = table.Column<string>(type: "TEXT", nullable: false),
                    Total = table.Column<decimal>(type: "TEXT", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Order", x => new { x.CustomerId, x.Id });
                    table.ForeignKey(
                        name: "FK_Order_Customers_CustomerId",
                        column: x => x.CustomerId,
                        principalTable: "Customers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "OrderLine",
                columns: table => new
                {
                    OrderCustomerId = table.Column<int>(type: "INTEGER", nullable: false),
                    OrderId = table.Column<int>(type: "INTEGER", nullable: false),
                    Id = table.Column<int>(type: "INTEGER", nullable: false),
                    Sku = table.Column<string>(type: "TEXT", nullable: false),
                    Quantity = table.Column<int>(type: "INTEGER", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_OrderLine", x => new { x.OrderCustomerId, x.OrderId, x.Id });
                    table.ForeignKey(
                        name: "FK_OrderLine_Order_OrderCustomerId_OrderId",
                        columns: x => new { x.OrderCustomerId, x.OrderId },
                        principalTable: "Order",
                        principalColumns: new[] { "CustomerId", "Id" },
                        onDelete: ReferentialAction.Cascade);
                });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "OrderLine");

            migrationBuilder.DropTable(
                name: "Order");

            migrationBuilder.DropTable(
                name: "Customers");
        }
    }
}
