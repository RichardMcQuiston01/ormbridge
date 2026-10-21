using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Rename.Migrations
{
    /// <inheritdoc />
    public partial class RenameTable : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropForeignKey(
                name: "FK_Books_Writers_WriterId",
                table: "Books");

            migrationBuilder.DropPrimaryKey(
                name: "PK_Writers",
                table: "Writers");

            migrationBuilder.RenameTable(
                name: "Writers",
                newName: "People");

            migrationBuilder.RenameIndex(
                name: "IX_Books_Title",
                table: "Books",
                newName: "IX_Books_ByTitle");

            migrationBuilder.AddPrimaryKey(
                name: "PK_People",
                table: "People",
                column: "Id");

            migrationBuilder.AddForeignKey(
                name: "FK_Books_People_WriterId",
                table: "Books",
                column: "WriterId",
                principalTable: "People",
                principalColumn: "Id",
                onDelete: ReferentialAction.Cascade);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropForeignKey(
                name: "FK_Books_People_WriterId",
                table: "Books");

            migrationBuilder.DropPrimaryKey(
                name: "PK_People",
                table: "People");

            migrationBuilder.RenameTable(
                name: "People",
                newName: "Writers");

            migrationBuilder.RenameIndex(
                name: "IX_Books_ByTitle",
                table: "Books",
                newName: "IX_Books_Title");

            migrationBuilder.AddPrimaryKey(
                name: "PK_Writers",
                table: "Writers",
                column: "Id");

            migrationBuilder.AddForeignKey(
                name: "FK_Books_Writers_WriterId",
                table: "Books",
                column: "WriterId",
                principalTable: "Writers",
                principalColumn: "Id",
                onDelete: ReferentialAction.Cascade);
        }
    }
}
