using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Fleet.V2.Migrations
{
    /// <inheritdoc />
    public partial class Axles : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<int>(
                name: "Axles",
                table: "Vehicles",
                type: "INTEGER",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "Axles",
                table: "Vehicles");
        }
    }
}
