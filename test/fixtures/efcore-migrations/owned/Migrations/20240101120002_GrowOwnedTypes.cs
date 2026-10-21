using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Owned.V2.Migrations
{
    /// <inheritdoc />
    public partial class GrowOwnedTypes : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<decimal>(
                name: "UnitPrice",
                table: "OrderLine",
                type: "TEXT",
                nullable: false,
                defaultValue: 0m);

            migrationBuilder.AddColumn<string>(
                name: "Notes",
                table: "Order",
                type: "TEXT",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "Home_Zip",
                table: "Customers",
                type: "TEXT",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "Work_Zip",
                table: "Customers",
                type: "TEXT",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "UnitPrice",
                table: "OrderLine");

            migrationBuilder.DropColumn(
                name: "Notes",
                table: "Order");

            migrationBuilder.DropColumn(
                name: "Home_Zip",
                table: "Customers");

            migrationBuilder.DropColumn(
                name: "Work_Zip",
                table: "Customers");
        }
    }
}
